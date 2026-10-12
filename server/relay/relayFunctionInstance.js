import { createRelayPacket, assertCuePacket, assertDeliveryStage, assertRelayPacket, meetingChannel, RELAY_CUE_TYPES, RELAY_REQUEST_TYPES, RELAY_STAGES } from '../../src/relay/protocol.js';

export class RelayFunctionInstance {
  constructor({ functionInstanceId, bus, registry, shareStateStore, requestTimeoutMs = 500, maxRequestRetries = 2, idFactory = defaultId, logger = console } = {}) {
    if (!functionInstanceId || !bus || !registry || !shareStateStore) throw new TypeError('Relay function dependencies required.');
    Object.assign(this, { functionInstanceId, bus, registry, shareStateStore, requestTimeoutMs, maxRequestRetries, idFactory, logger });
    this.devices = new Map(); // Function-local socket adapter, never stored in the registry.
    this.viewers = new Map(); // Function-local socket adapter, never stored in the registry.
    this.subscriptions = new Map();
    this.pending = new Map();
  }

  async connectDevice({ deviceId, meetingId, connectionId, generation = 0, socket, ttlMs } = {}) {
    await this.shareStateStore.assertActive(meetingId);
    const metadata = await this.registry.register({ role: 'device', deviceId, meetingId, connectionId, functionInstanceId: this.functionInstanceId, generation, ttlMs });
    this.devices.set(connectionId, { socket, metadata });
    this.bindSocket(socket, (packet) => this.handleDevicePacket(metadata, packet), () => this.disconnectDevice(metadata));
    await this.ensureSubscribed(meetingId);
    return metadata;
  }

  async connectViewer({ meetingId, connectionId, socket, ttlMs } = {}) {
    await this.shareStateStore.assertActive(meetingId);
    const metadata = await this.registry.register({ role: 'viewer', meetingId, connectionId, functionInstanceId: this.functionInstanceId, ttlMs });
    const viewer = { metadata, socket, cursor: 0, snapshotReady: false, buffered: [], replayRequested: false };
    this.viewers.set(connectionId, viewer);
    this.bindSocket(socket, (packet) => this.handleViewerPacket(viewer, packet), () => this.disconnectViewer(viewer));
    await this.ensureSubscribed(meetingId); // Subscribe before requesting snapshot so the handoff buffers live events.
    await this.requestDevice(viewer, 'snapshot.request', 0);
    return metadata;
  }

  async stopOrRevoke(meetingId, status) {
    await this.shareStateStore.setStatus(meetingId, status);
    await this.bus.publish(meetingChannel(meetingId), createRelayPacket('share.status', { meetingId, status }));
  }

  async handleDevicePacket(metadata, packet) {
    try {
      assertRelayPacket(packet);
      if (packet.meetingId !== metadata.meetingId) throw new Error('Device packet meeting mismatch.');
      if (RELAY_CUE_TYPES.has(packet.type)) {
        await this.shareStateStore.assertActive(packet.meetingId);
        assertCuePacket(packet);
        await this.registry.updateDeviceSequence(packet.meetingId, metadata.connectionId, packet.event.sequence);
        await this.bus.publish(meetingChannel(packet.meetingId), { ...packet, deviceConnectionId: metadata.connectionId, generation: metadata.generation });
        this.send(metadata.connectionId, createRelayPacket('ack', { meetingId: packet.meetingId, stage: RELAY_STAGES.relayForwarded, sequence: packet.event.sequence }));
        return;
      }
      if (packet.type === 'device.status') {
        await this.shareStateStore.assertActive(packet.meetingId);
        assertDeliveryStage(packet.stage);
        if (![RELAY_STAGES.devicePendingDurable, RELAY_STAGES.deviceApplied].includes(packet.stage)) throw new Error('Device status must be a device stage.');
        await this.bus.publish(meetingChannel(packet.meetingId), { ...packet, deviceConnectionId: metadata.connectionId });
        return;
      }
      if (packet.type === 'snapshot.response' || packet.type === 'replay.response') {
        await this.shareStateStore.assertActive(packet.meetingId);
        if (!packet.requestId || !packet.targetConnectionId) throw new Error('Relay response requires requestId and targetConnectionId.');
        await this.bus.publish(meetingChannel(packet.meetingId), { ...packet, deviceConnectionId: metadata.connectionId });
      }
    } catch (error) { this.send(metadata.connectionId, createRelayPacket('error', { meetingId: metadata.meetingId, code: 'relay_packet_rejected', message: error.message })); }
  }

  async handleViewerPacket(viewer, packet) {
    try {
      assertRelayPacket(packet);
      if (packet.meetingId !== viewer.metadata.meetingId) throw new Error('Viewer packet meeting mismatch.');
      if (RELAY_REQUEST_TYPES.has(packet.type)) {
        await this.shareStateStore.assertActive(packet.meetingId);
        await this.requestDevice(viewer, packet.type, viewer.cursor, packet.requestId);
      }
    } catch (error) { this.send(viewer.metadata.connectionId, createRelayPacket('error', { meetingId: viewer.metadata.meetingId, code: 'relay_request_rejected', message: error.message })); }
  }

  async requestDevice(viewer, type, afterSequence, requestId = this.idFactory()) {
    await this.shareStateStore.assertActive(viewer.metadata.meetingId);
    const device = await this.registry.findDevice(viewer.metadata.meetingId);
    if (!device) throw new Error('No active device connection.');
    const key = `${viewer.metadata.connectionId}:${requestId}`;
    const pending = this.pending.get(key) || { viewer, type, requestId, afterSequence, attempts: 0 };
    pending.attempts += 1;
    this.pending.set(key, pending);
    await this.bus.publish(meetingChannel(viewer.metadata.meetingId), createRelayPacket(type, {
      meetingId: viewer.metadata.meetingId,
      requestId,
      afterSequence,
      targetConnectionId: device.connectionId,
      viewerConnectionId: viewer.metadata.connectionId,
      generation: device.generation
    }));
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => this.retryRequest(key), this.requestTimeoutMs);
    return requestId;
  }

  async retryRequest(key) {
    const pending = this.pending.get(key);
    if (!pending) return;
    if (pending.attempts > this.maxRequestRetries) {
      this.pending.delete(key);
      this.send(pending.viewer.metadata.connectionId, createRelayPacket('error', { meetingId: pending.viewer.metadata.meetingId, code: 'relay_request_timeout', requestId: pending.requestId }));
      return;
    }
    try { await this.requestDevice(pending.viewer, pending.type, pending.afterSequence, pending.requestId); }
    catch (error) { this.pending.delete(key); this.send(pending.viewer.metadata.connectionId, createRelayPacket('error', { meetingId: pending.viewer.metadata.meetingId, code: 'relay_request_rejected', message: error.message })); }
  }

  async ensureSubscribed(meetingId) {
    if (this.subscriptions.has(meetingId)) return;
    const unsubscribe = await this.bus.subscribe(meetingChannel(meetingId), (packet) => this.receiveBusPacket(packet), () => this.recoverSubscription(meetingId));
    this.subscriptions.set(meetingId, unsubscribe);
  }

  async recoverSubscription(meetingId) {
    this.subscriptions.delete(meetingId);
    await this.ensureSubscribed(meetingId);
    for (const viewer of this.viewers.values()) {
      if (viewer.metadata.meetingId === meetingId && viewer.socket.readyState === viewer.socket.OPEN) this.requestReplay(viewer);
    }
  }

  async receiveBusPacket(packet) {
    try {
      assertRelayPacket(packet);
      if (packet.type === 'share.status') return this.closeMeetingViewers(packet.meetingId, packet.status);
      if (RELAY_REQUEST_TYPES.has(packet.type)) return this.deliverDeviceRequest(packet);
      if (RELAY_CUE_TYPES.has(packet.type)) return this.deliverLiveCue(packet);
      if (packet.type === 'snapshot.response' || packet.type === 'replay.response') return this.deliverDeviceResponse(packet);
      if (packet.type === 'device.status') return this.deliverDeviceStatus(packet);
      if (packet.type === 'viewer.cursor') return this.deliverViewerCursor(packet);
    } catch (error) { this.logger.warn?.('relay_bus_packet_rejected', { message: error.message }); }
  }

  deliverDeviceRequest(packet) {
    if (!this.devices.has(packet.targetConnectionId)) return;
    this.shareStateStore.assertActive(packet.meetingId)
      .then(() => this.send(packet.targetConnectionId, packet))
      .catch(() => undefined);
  }

  deliverLiveCue(packet) {
    for (const viewer of this.viewers.values()) if (viewer.metadata.meetingId === packet.meetingId) this.receiveLiveCue(viewer, packet);
  }

  deliverDeviceResponse(packet) {
    const viewer = this.viewers.get(packet.targetConnectionId);
    if (!viewer) return;
    const key = `${viewer.metadata.connectionId}:${packet.requestId}`;
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(key);
    if (packet.type === 'snapshot.response') {
      viewer.cursor = Number(packet.cursor) || 0;
      viewer.snapshotReady = true;
      this.send(viewer.metadata.connectionId, createRelayPacket('snapshot', { meetingId: packet.meetingId, requestId: packet.requestId, cursor: viewer.cursor, cues: packet.cues || [] }));
      const buffered = viewer.buffered.splice(0).sort(bySequence);
      for (const event of buffered) this.applyViewerCue(viewer, event);
      return;
    }
    for (const event of [...(packet.events || [])].sort(bySequence)) this.applyViewerCue(viewer, event);
  }

  deliverDeviceStatus(packet) {
    for (const viewer of this.viewers.values()) if (viewer.metadata.meetingId === packet.meetingId) this.send(viewer.metadata.connectionId, packet);
  }

  deliverViewerCursor(packet) {
    for (const { metadata } of this.devices.values()) if (metadata.meetingId === packet.meetingId) this.send(metadata.connectionId, packet);
  }

  receiveLiveCue(viewer, packet) {
    if (!viewer.snapshotReady) { viewer.buffered.push(packet); return; }
    this.applyViewerCue(viewer, packet);
  }

  applyViewerCue(viewer, packet) {
    const sequence = Number(packet.event?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence <= viewer.cursor) return;
    if (sequence !== viewer.cursor + 1) { viewer.buffered.push(packet); this.requestReplay(viewer); return; }
    viewer.cursor = sequence;
    this.send(viewer.metadata.connectionId, createRelayPacket('cue', { meetingId: viewer.metadata.meetingId, event: packet.event, cursor: viewer.cursor }));
    this.bus.publish(meetingChannel(viewer.metadata.meetingId), createRelayPacket('viewer.cursor', { meetingId: viewer.metadata.meetingId, stage: RELAY_STAGES.viewerCursor, viewerConnectionId: viewer.metadata.connectionId, cursor: viewer.cursor })).catch(() => undefined);
  }

  requestReplay(viewer) {
    if (viewer.replayRequested) return;
    viewer.replayRequested = true;
    this.requestDevice(viewer, 'replay.request', viewer.cursor)
      .catch((error) => this.send(viewer.metadata.connectionId, createRelayPacket('error', { meetingId: viewer.metadata.meetingId, code: 'relay_replay_rejected', message: error.message })))
      .finally(() => { viewer.replayRequested = false; });
  }

  closeMeetingViewers(meetingId, status) {
    for (const viewer of this.viewers.values()) if (viewer.metadata.meetingId === meetingId) viewer.socket.close(1008, status);
  }

  send(connectionId, packet) {
    const target = this.devices.get(connectionId)?.socket || this.viewers.get(connectionId)?.socket;
    if (target?.readyState === target?.OPEN) target.send(JSON.stringify(packet));
  }

  bindSocket(socket, onPacket, onClose) {
    socket.on('message', (raw) => { let packet; try { packet = JSON.parse(raw.toString()); } catch { return; } onPacket(packet); });
    socket.on('close', onClose);
  }

  async disconnectDevice(metadata) { this.devices.delete(metadata.connectionId); await this.registry.remove(metadata); }
  async disconnectViewer(viewer) { this.viewers.delete(viewer.metadata.connectionId); await this.registry.remove(viewer.metadata); }
}

function bySequence(left, right) { return Number(left.event?.sequence) - Number(right.event?.sequence); }
function defaultId() { return `relay-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
