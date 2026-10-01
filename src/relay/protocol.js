export const RELAY_PROTOCOL_VERSION = 'subtitle-relay/v1';

export const RELAY_STAGES = Object.freeze({
  relayForwarded: 'relay_forwarded',
  devicePendingDurable: 'device_pending_durable',
  deviceApplied: 'device_applied',
  viewerCursor: 'viewer_cursor'
});

export const RELAY_CUE_TYPES = new Set(['cue.append', 'cue.update']);
export const RELAY_REQUEST_TYPES = new Set(['snapshot.request', 'replay.request']);

export function meetingChannel(meetingId) {
  return `subtitle-relay:${String(meetingId)}`;
}

export function assertRelayPacket(packet, { requireRequestId = false } = {}) {
  if (!packet || packet.protocol !== RELAY_PROTOCOL_VERSION || typeof packet.type !== 'string') {
    throw new TypeError('Invalid relay protocol packet.');
  }
  if (!nonEmpty(packet.meetingId)) throw new TypeError('Relay packet requires meetingId.');
  if (requireRequestId && !nonEmpty(packet.requestId)) throw new TypeError('Relay request requires requestId.');
  return packet;
}

export function assertCuePacket(packet) {
  assertRelayPacket(packet);
  if (!RELAY_CUE_TYPES.has(packet.type) || !Number.isSafeInteger(packet.event?.sequence) || packet.event.sequence < 1) {
    throw new TypeError('Relay cue packet requires a positive event sequence.');
  }
  return packet;
}

export function assertDeliveryStage(stage) {
  if (!Object.values(RELAY_STAGES).includes(stage)) throw new TypeError('Unknown relay delivery stage.');
  return stage;
}

export function createRelayPacket(type, fields = {}) {
  return { protocol: RELAY_PROTOCOL_VERSION, type, ...fields };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}
