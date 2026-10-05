function assertMetadata(metadata) {
  for (const field of ['meetingId', 'connectionId', 'functionInstanceId']) {
    if (typeof metadata?.[field] !== 'string' || metadata[field].length === 0) throw new TypeError(`Relay metadata requires ${field}.`);
  }
  if (metadata.role === 'device' && (typeof metadata.deviceId !== 'string' || metadata.deviceId.length === 0)) {
    throw new TypeError('Device metadata requires deviceId.');
  }
}

export class RelayRegistry {
  constructor({ store, now = () => Date.now(), defaultTtlMs = 30_000 } = {}) {
    if (!store?.get || !store?.set || !store?.delete) throw new TypeError('RelayRegistry requires a metadata store.');
    this.store = store;
    this.now = now;
    this.defaultTtlMs = defaultTtlMs;
  }

  async register(metadata) {
    assertMetadata(metadata);
    const ttlMs = Number(metadata.ttlMs) || this.defaultTtlMs;
    const value = {
      role: metadata.role || 'viewer',
      deviceId: metadata.deviceId || null,
      meetingId: metadata.meetingId,
      connectionId: metadata.connectionId,
      functionInstanceId: metadata.functionInstanceId,
      generation: Number(metadata.generation) || 0,
      lastSequence: Number(metadata.lastSequence) || 0,
      expiresAt: this.now() + ttlMs
    };
    await this.store.set(this.key(value), value, ttlMs);
    return value;
  }

  async findDevice(meetingId) {
    const metadata = await this.store.get(this.deviceKey(meetingId));
    return metadata?.role === 'device' ? metadata : null;
  }

  async updateDeviceSequence(meetingId, connectionId, sequence) {
    const current = await this.findDevice(meetingId);
    if (!current || current.connectionId !== connectionId) throw new Error('Device connection is not current.');
    if (sequence <= current.lastSequence) throw new Error('Relay sequence must be strictly monotonic.');
    return this.register({ ...current, lastSequence: sequence, ttlMs: Math.max(1, current.expiresAt - this.now()) });
  }

  async remove(metadata) {
    await this.store.delete(this.key(metadata));
  }

  key(metadata) {
    return metadata.role === 'device' ? this.deviceKey(metadata.meetingId) : `relay:viewer:${metadata.meetingId}:${metadata.connectionId}`;
  }

  deviceKey(meetingId) {
    return `relay:device:${meetingId}`;
  }
}

export class RedisRelayMetadataStore {
  constructor({ redis } = {}) {
    if (!redis) throw new TypeError('RedisRelayMetadataStore requires Redis.');
    this.redis = redis;
  }

  async get(key) {
    const value = await this.redis.get(key);
    return value ? JSON.parse(value) : null;
  }

  async set(key, value, ttlMs) {
    await this.redis.set(key, JSON.stringify(value), 'PX', ttlMs);
  }

  async delete(key) {
    await this.redis.del(key);
  }
}

export class RedisRelayShareStateStore {
  constructor({ redis } = {}) {
    if (!redis) throw new TypeError('RedisRelayShareStateStore requires Redis.');
    this.redis = redis;
  }

  async setStatus(meetingId, status) {
    if (!['active', 'stopped', 'revoked'].includes(status)) throw new TypeError('Invalid persisted share status.');
    await this.redis.set(`relay:share:${meetingId}`, JSON.stringify({ meetingId, status, updatedAt: Date.now() }));
  }

  async assertActive(meetingId) {
    const raw = await this.redis.get(`relay:share:${meetingId}`);
    const state = raw ? JSON.parse(raw) : null;
    if (!state || state.status !== 'active') throw new Error('Relay share is stopped or revoked.');
    return state;
  }
}
