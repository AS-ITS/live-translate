(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = { role: $('role'), meeting: $('meetingId'), share: $('share'), participant: $('participantId'), url: $('signalingUrl'), status: $('status'), pair: $('candidatePair'), peers: $('peerCount'), process: $('processTime'), latency: $('cueLatency'), cues: $('cues'), log: $('log'), start: $('start'), send: $('send'), update: $('update'), replay: $('replay'), stop: $('stop') };
  const state = { pc: null, channel: null, timer: null, statsTimer: null, pollAfter: 0, sequence: 0, snapshot: false, buffered: [], cues: new Map(), stopping: false, reconnecting: false, processStarted: 0 };

  function baseUrl() {
    const raw = ui.url.value.trim() || `${location.origin}/api/webrtc/${encodeURIComponent(ui.meeting.value.trim())}`;
    return raw.replace(/\/$/, '');
  }
  function setStatus(value) { ui.status.textContent = value; }
  function log(value) { ui.log.textContent = `${new Date().toISOString()} ${value}\n${ui.log.textContent}`.slice(0, 6000); }
  function participant() { return ui.participant.value.trim() || `browser-${Math.random().toString(36).slice(2, 8)}`; }
  function payload(extra = {}) {
    const credential = ui.share.value.trim();
    const isCode = /^[A-HJ-NP-Z2-9]{8}$/iu.test(credential);
    return { meetingId: ui.meeting.value.trim(), participantId: participant(), role: ui.role.value, ...(isCode ? { shareCode: credential } : { shareToken: credential }), ...extra };
  }
  async function jsonFetch(path, options = {}) {
    const response = await fetch(`${baseUrl()}${path}`, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const code = typeof body?.error?.code === 'string' ? body.error.code : 'http_error';
      throw new Error(`${path} failed (${response.status}, ${code})`);
    }
    return response.status === 204 ? {} : response.json();
  }
  function send(message) {
    if (state.channel?.readyState === 'open') state.channel.send(JSON.stringify({ protocol: 'webrtc-subtitle-poc/v1', ...message }));
  }
  function renderCue(cue) {
    const row = document.createElement('div');
    row.textContent = `${cue.sequence ?? '?'} ${cue.text || cue.translation || ''}`;
    ui.cues.append(row);
  }
  function applyCue(message) {
    const cue = message.cue || {};
    const previous = state.cues.get(cue.cueId);
    if (previous && (cue.revision || 0) <= (previous.revision || 0)) return;
    state.cues.set(cue.cueId, cue);
    ui.cues.replaceChildren(...[...state.cues.values()].sort((a, b) => a.sequence - b.sequence).map((item) => {
      const row = document.createElement('div'); row.textContent = `${item.sequence ?? '?'} ${item.text || item.translation || ''}`; return row;
    }));
    if (cue.sentAt) ui.latency.textContent = `${Math.max(0, Date.now() - cue.sentAt).toFixed(1)} ms`;
  }
  function accept(message) {
    if (message.type === 'revoked') { state.stopping = true; setStatus('revoked'); closePeer(); return; }
    if (message.type === 'replay.request' && ui.role.value === 'device') {
      send({ type: 'replay.response', requestId: message.requestId, events: [...state.cues.values()].map((cue) => ({ type: 'cue.append', sequence: cue.sequence, cue })) });
      return;
    }
    if (message.type === 'snapshot') {
      state.snapshot = true; state.sequence = message.sequence || 0;
      (message.cues || []).forEach((cue) => applyCue({ cue }));
      state.buffered.sort((a, b) => a.sequence - b.sequence).forEach(accept); state.buffered = [];
      return;
    }
    if (message.type === 'replay.response') { (message.events || []).forEach(accept); return; }
    if (message.type !== 'cue.append' && message.type !== 'cue.update') return;
    if (!state.snapshot) { state.buffered.push(message); return; }
    if (message.sequence > state.sequence + 1) { send({ type: 'replay.request', afterSequence: state.sequence, requestId: crypto.randomUUID() }); log(`sequence gap ${state.sequence} -> ${message.sequence}, replay requested`); return; }
    if (message.sequence < state.sequence || (message.sequence === state.sequence && message.type !== 'cue.update')) return;
    state.sequence = message.sequence; applyCue(message);
  }
  function closePeer() { clearInterval(state.timer); clearInterval(state.statsTimer); state.timer = state.statsTimer = null; state.channel?.close(); state.pc?.close(); state.channel = state.pc = null; }
  function candidateClass(local, remote) {
    const types = [local, remote];
    if (types.includes('relay')) return 'TURN';
    if (types.every((type) => ['host', 'srflx', 'prflx'].includes(type))) return 'direct';
    return 'unknown';
  }
  async function updateStats() {
    if (!state.pc) return;
    const stats = await state.pc.getStats(); let pair;
    stats.forEach((item) => { if (item.type === 'candidate-pair' && (item.selected || item.nominated)) pair = item; });
    if (!pair) return;
    const local = stats.get(pair.localCandidateId); const remote = stats.get(pair.remoteCandidateId);
    ui.pair.textContent = candidateClass(local?.candidateType, remote?.candidateType);
    if (ui.pair.textContent === 'unknown') log('ICE candidate pair is unknown, not counted as direct');
  }
  async function signal(type, value) { await jsonFetch('/signal', { method: 'POST', body: JSON.stringify(payload({ type, payload: value })) }); }
  async function pollSignals() {
    try {
      const query = `/signal?participantId=${encodeURIComponent(participant())}&after=${state.pollAfter}`;
      const result = await jsonFetch(query);
      for (const message of (result.messages || result || [])) { state.pollAfter = Math.max(state.pollAfter, message.sequence || message.sentAt || state.pollAfter); await handleSignal(message); }
    } catch (error) { if (!state.stopping) log(error.message); }
  }
  async function handleSignal(message) {
    if (!state.pc) return;
    if (message.type === 'offer' && ui.role.value === 'viewer') { await state.pc.setRemoteDescription(message.payload || message); const answer = await state.pc.createAnswer(); await state.pc.setLocalDescription(answer); await signal('answer', state.pc.localDescription); }
    if (message.type === 'answer' && ui.role.value === 'device') await state.pc.setRemoteDescription(message.payload || message);
    if (message.type === 'ice-candidate') try { await state.pc.addIceCandidate(message.payload || message.candidate || message); } catch (error) { log(`ICE candidate rejected: ${error.message}`); }
    if (message.type === 'revoked') { state.stopping = true; setStatus('revoked'); closePeer(); }
  }
  async function connect() {
    closePeer(); state.snapshot = false; state.buffered = []; state.pollAfter = 0;
    const response = await jsonFetch('/join', { method: 'POST', body: JSON.stringify(payload()) });
    ui.peers.textContent = String(response.peerCount ?? response.peers?.length ?? 1);
    state.pc = new RTCPeerConnection({ iceServers: response.iceServers || [] });
    state.pc.onicecandidate = ({ candidate }) => candidate && signal('ice-candidate', candidate).catch((error) => log(error.message));
    state.pc.onconnectionstatechange = () => { setStatus(state.pc.connectionState); if (['failed', 'disconnected'].includes(state.pc.connectionState) && !state.stopping && !state.reconnecting) reconnect(); };
    state.pc.ondatachannel = (event) => { state.channel = event.channel; wireChannel(); };
    if (ui.role.value === 'device') { state.channel = state.pc.createDataChannel('subtitles'); wireChannel(); const offer = await state.pc.createOffer(); await state.pc.setLocalDescription(offer); await signal('offer', state.pc.localDescription); }
    state.timer = setInterval(pollSignals, 250);
    state.statsTimer = setInterval(updateStats, 1000);
    if (ui.role.value === 'device') ui.send.disabled = false;
    ui.update.disabled = false;
    ui.replay.disabled = false; ui.stop.disabled = false; setStatus('connecting');
  }
  function wireChannel() {
    state.channel.onopen = () => { setStatus('connected'); if (ui.role.value === 'device') send({ type: 'snapshot', sequence: state.sequence, cues: [...state.cues.values()] }); };
    state.channel.onmessage = (event) => { try { accept(JSON.parse(event.data)); } catch (error) { log(`invalid DataChannel message: ${error.message}`); } };
    state.channel.onclose = () => { if (!state.stopping && !state.reconnecting) reconnect(); };
  }
  async function reconnect() { state.reconnecting = true; setStatus('reconnecting'); try { await connect(); } catch (error) { setStatus(`reconnect failed: ${error.message}`); } finally { state.reconnecting = false; } }
  function sendCue() {
    const started = performance.now(); const cue = { cueId: crypto.randomUUID(), sequence: ++state.sequence, revision: 0, text: `Synthetic cue ${state.sequence}`, sentAt: Date.now(), processedAt: Date.now() };
    ui.process.textContent = `${(performance.now() - started).toFixed(1)} ms`; send({ type: 'cue.append', sequence: cue.sequence, cue }); applyCue({ cue });
  }
  function updateCue() {
    const existing = [...state.cues.values()].sort((a, b) => a.sequence - b.sequence)[0];
    if (!existing) { log('cue.update requires an existing cue'); return; }
    const cue = { ...existing, revision: (existing.revision || 0) + 1, text: `${existing.text || ''} (updated)` };
    send({ type: 'cue.update', sequence: cue.sequence, cue }); applyCue({ cue });
  }
  async function stop() { state.stopping = true; send({ type: 'revoked' }); try { await jsonFetch('/stop', { method: 'POST', body: JSON.stringify(payload()) }); } catch (error) { log(error.message); } closePeer(); setStatus('revoked'); ui.send.disabled = true; ui.update.disabled = true; ui.replay.disabled = true; ui.stop.disabled = true; }
  ui.url.value = `${location.origin}/api/webrtc/${encodeURIComponent(ui.meeting.value)}`;
  ui.meeting.oninput = () => { if (!ui.url.dataset.edited) ui.url.value = `${location.origin}/api/webrtc/${encodeURIComponent(ui.meeting.value)}`; };
  ui.url.oninput = () => { ui.url.dataset.edited = 'true'; };
  ui.start.onclick = async () => { state.stopping = false; try { await connect(); } catch (error) { setStatus(`failed: ${error.message}`); log(error.message); } };
  ui.send.onclick = sendCue;
  ui.update.onclick = updateCue;
  ui.replay.onclick = () => send({ type: 'replay.request', afterSequence: state.sequence, requestId: crypto.randomUUID() });
  ui.stop.onclick = stop;
})();
