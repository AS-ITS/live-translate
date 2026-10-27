// The store owns the files; this module owns the on-disk commit protocol.
export const PCM_JOURNAL_SEGMENT_BYTES = 8 * 1024 * 1024;
export const PCM_JOURNAL_MAX_BYTES = 320 * 1024 * 1024;
export const PCM_JOURNAL_MAX_CLAIMS = 20_000;
const MAX_LEDGER_RECORD_BYTES = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function journalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function digest(bytes) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function sameClaim(a, b) {
  return a.recordingId === b.recordingId && a.captureEpoch === b.captureEpoch
    && a.startSample === b.startSample && a.endSample === b.endSample && a.sha256 === b.sha256;
}

function validPart(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
}

export function createDurablePcmJournal({ store, recordingId, maxBytes = PCM_JOURNAL_MAX_BYTES,
  maxClaims = PCM_JOURNAL_MAX_CLAIMS, segmentBytes = PCM_JOURNAL_SEGMENT_BYTES } = {}) {
  if (!store || !validPart(recordingId)) throw new TypeError('valid store and recordingId required');
  let ledger;
  let segment;
  let openSegmentNumber = 0;
  let segmentNumber = 0;
  let segmentOffset = 0;
  let committedBytes = 0;
  let ledgerOffset = 0;
  let highestEpoch = 0;
  let tailState = 'CLEAN';
  const claims = [];
  const operations = new Map();
  const closedEpochs = new Map();
  const begunEpochs = new Set();

  async function file(number) {
    if (openSegmentNumber !== number || !segment) {
      segment?.close();
      segment = await store.segment(recordingId, number);
      openSegmentNumber = number;
    }
    return segment;
  }

  async function readLedgerRecord(offset, size) {
    if (offset + 4 > size) return null;
    const head = await ledger.read(offset, 4);
    if (head.length !== 4) return null;
    const length = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, true);
    if (length < 2 || length > MAX_LEDGER_RECORD_BYTES || offset + 4 + length + 32 > size) return null;
    const body = await ledger.read(offset + 4, length + 32);
    if (body.length !== length + 32) return null;
    const payload = body.subarray(0, length);
    const hash = body.subarray(length);
    const actual = await globalThis.crypto.subtle.digest('SHA-256', payload);
    if (hash.some((value, index) => value !== new Uint8Array(actual)[index])) return null;
    try {
      return { value: JSON.parse(decoder.decode(payload)), next: offset + 4 + length + 32 };
    } catch { return null; }
  }

  async function appendLedger(value) {
    const payload = encoder.encode(JSON.stringify(value));
    if (payload.length > MAX_LEDGER_RECORD_BYTES) throw journalError('LEDGER_RECORD_TOO_LARGE');
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', payload));
    const record = new Uint8Array(4 + payload.length + hash.length);
    new DataView(record.buffer).setUint32(0, payload.length, true);
    record.set(payload, 4);
    record.set(hash, 4 + payload.length);
    if (await ledger.getSize() !== ledgerOffset) throw journalError('LEDGER_TAIL_CHANGED');
    await ledger.write(ledgerOffset, record);
    await ledger.flush();
    const verified = await readLedgerRecord(ledgerOffset, await ledger.getSize());
    if (!verified || JSON.stringify(verified.value) !== JSON.stringify(value)) throw journalError('LEDGER_COMMIT_UNKNOWN');
    ledgerOffset = verified.next;
  }

  return Object.freeze({
    async open() {
      ledger = await store.ledger(recordingId);
      const size = await ledger.getSize();
      let cursor = 0;
      while (cursor < size) {
        const entry = await readLedgerRecord(cursor, size);
        if (!entry || entry.value.version !== 1 || entry.value.recordingId !== recordingId) {
          tailState = 'CORRUPT_OR_INCOMPLETE_LEDGER';
          break;
        }
        const value = entry.value;
        if (value.type === 'begin' && Number.isSafeInteger(value.captureEpoch) && value.captureEpoch > 0) {
          if (value.captureEpoch <= highestEpoch || begunEpochs.has(value.captureEpoch)) {
            tailState = 'CORRUPT_OR_INCOMPLETE_LEDGER';
            break;
          }
          begunEpochs.add(value.captureEpoch);
        } else if (value.type === 'pcm') {
          const positionMatches = claims.length === 0
            ? value.segment === 1 && value.offset === 0
            : (value.segment === segmentNumber && value.offset === segmentOffset)
              || (value.segment === segmentNumber + 1 && value.offset === 0);
          if (!validClaim(value) || !positionMatches || claims.length >= maxClaims
            || operations.has(value.operationId) || closedEpochs.has(value.captureEpoch)
            || claims.some((item) => item.captureEpoch === value.captureEpoch
              && value.startSample < item.endSample && value.endSample > item.startSample)) {
            tailState = 'CORRUPT_OR_INCOMPLETE_LEDGER';
            break;
          }
          const data = await file(value.segment);
          const bytes = await data.read(value.offset, value.byteLength);
          if (bytes.length !== value.byteLength || await digest(bytes) !== value.sha256) {
            tailState = 'CORRUPT_PCM';
            break;
          }
          claims.push(value);
          operations.set(value.operationId, value);
          committedBytes += value.byteLength;
          segmentNumber = value.segment;
          segmentOffset = value.offset + value.byteLength;
        } else if (value.type === 'end' && Number.isSafeInteger(value.captureEpoch)
          && value.captureEpoch > 0 && Number.isSafeInteger(value.endSample) && value.endSample >= 0
          && !closedEpochs.has(value.captureEpoch)
          && value.endSample >= claims.filter((item) => item.captureEpoch === value.captureEpoch)
            .reduce((maximum, item) => Math.max(maximum, item.endSample), 0)) {
          closedEpochs.set(value.captureEpoch, value.endSample);
        } else {
          tailState = 'CORRUPT_OR_INCOMPLETE_LEDGER';
          break;
        }
        highestEpoch = Math.max(highestEpoch, value.captureEpoch);
        cursor = entry.next;
      }
      ledgerOffset = cursor;
      return this.status();
    },

    async append({ operationId, captureEpoch, startSample, bytes } = {}) {
      if (!ledger || tailState !== 'CLEAN') throw journalError(tailState === 'CLEAN' ? 'JOURNAL_NOT_OPEN' : tailState);
      if (!validPart(operationId) || !Number.isSafeInteger(captureEpoch) || captureEpoch < 1
        || !Number.isSafeInteger(startSample) || startSample < 0
        || !(bytes instanceof Uint8Array) || bytes.length < 2 || bytes.length % 2 !== 0
        || bytes.length > 32_000) throw journalError('INVALID_PCM_CLAIM');
      const sha256 = await digest(bytes);
      const claim = { version: 1, type: 'pcm', recordingId, operationId, captureEpoch,
        startSample, endSample: startSample + bytes.length / 2, sha256 };
      const prior = operations.get(operationId);
      if (prior) {
        if (!sameClaim(prior, claim)) throw journalError('OPERATION_CONFLICT');
        return { state: 'COMMITTED', duplicate: true, claim: prior };
      }
      if (captureEpoch < highestEpoch || closedEpochs.has(captureEpoch)) throw journalError('CAPTURE_EPOCH_CLOSED');
      if (claims.length >= maxClaims) throw journalError('JOURNAL_INDEX_LIMIT');
      if (committedBytes + bytes.length > maxBytes) throw journalError('JOURNAL_STORAGE_LIMIT');
      if (claims.some((item) => item.captureEpoch === captureEpoch
        && startSample < item.endSample && claim.endSample > item.startSample)) throw journalError('SAMPLE_RANGE_OVERLAP');
      let target = segmentNumber || 1;
      let offset = segmentOffset;
      if (offset + bytes.length > segmentBytes) { target += 1; offset = 0; }
      const data = await file(target);
      const size = await data.getSize();
      if (size < offset) throw journalError('PCM_TRUNCATED');
      if (size > offset) await data.truncate(offset); // unclaimed crash tail
      await data.write(offset, bytes);
      await data.flush();
      const verified = await data.read(offset, bytes.length);
      if (verified.length !== bytes.length || await digest(verified) !== sha256) throw journalError('PCM_VERIFY_FAILED');
      const durable = { ...claim, segment: target, offset, byteLength: bytes.length };
      await appendLedger(durable);
      claims.push(durable);
      operations.set(operationId, durable);
      committedBytes += bytes.length;
      segmentNumber = target;
      segmentOffset = offset + bytes.length;
      highestEpoch = Math.max(highestEpoch, captureEpoch);
      return { state: 'COMMITTED', duplicate: false, claim: durable };
    },

    async beginEpoch(captureEpoch) {
      if (!ledger || tailState !== 'CLEAN') throw journalError('JOURNAL_UNAVAILABLE');
      if (!Number.isSafeInteger(captureEpoch) || captureEpoch < 1) throw journalError('INVALID_CAPTURE_EPOCH');
      if (begunEpochs.has(captureEpoch)) return { state: 'COMMITTED', duplicate: true };
      if (captureEpoch <= highestEpoch) throw journalError('CAPTURE_EPOCH_CONFLICT');
      await appendLedger({ version: 1, type: 'begin', recordingId, captureEpoch });
      begunEpochs.add(captureEpoch);
      highestEpoch = captureEpoch;
      return { state: 'COMMITTED', duplicate: false };
    },

    async endEpoch(captureEpoch, endSample) {
      if (!ledger || tailState !== 'CLEAN') throw journalError('JOURNAL_UNAVAILABLE');
      if (!Number.isSafeInteger(captureEpoch) || captureEpoch < 1
        || !Number.isSafeInteger(endSample) || endSample < 0) throw journalError('INVALID_EPOCH_END');
      const prior = closedEpochs.get(captureEpoch);
      if (prior !== undefined) {
        if (prior !== endSample) throw journalError('EPOCH_END_CONFLICT');
        return { state: 'COMMITTED', duplicate: true };
      }
      const lastCommitted = claims.filter((item) => item.captureEpoch === captureEpoch)
        .reduce((maximum, item) => Math.max(maximum, item.endSample), 0);
      if (endSample < lastCommitted) throw journalError('EPOCH_END_BEFORE_DATA');
      await appendLedger({ version: 1, type: 'end', recordingId, captureEpoch, endSample });
      closedEpochs.set(captureEpoch, endSample);
      highestEpoch = Math.max(highestEpoch, captureEpoch);
      return { state: 'COMMITTED', duplicate: false };
    },

    coverage(captureEpoch, startSample, endSample) {
      const ranges = claims.filter((item) => item.captureEpoch === captureEpoch
        && item.endSample > startSample && item.startSample < endSample)
        .sort((a, b) => a.startSample - b.startSample);
      const gaps = [];
      let cursor = startSample;
      for (const item of ranges) {
        if (item.startSample > cursor) gaps.push([cursor, item.startSample]);
        cursor = Math.max(cursor, item.endSample);
      }
      if (cursor < endSample) gaps.push([cursor, endSample]);
      return { ranges, gaps, complete: gaps.length === 0,
        epochClosed: closedEpochs.has(captureEpoch), tailState };
    },

    async readRange(captureEpoch, startSample, endSample) {
      if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample)
        || startSample < 0 || endSample <= startSample || endSample - startSample > 480_000) {
        throw journalError('INVALID_READ_RANGE');
      }
      const result = this.coverage(captureEpoch, startSample, endSample);
      if (!result.complete) throw journalError('SAMPLE_RANGE_NOT_COMMITTED');
      const output = new Uint8Array((endSample - startSample) * 2);
      for (const item of result.ranges) {
        const data = await file(item.segment);
        const bytes = await data.read(item.offset, item.byteLength);
        if (await digest(bytes) !== item.sha256) throw journalError('PCM_CORRUPT');
        const from = Math.max(startSample, item.startSample);
        const to = Math.min(endSample, item.endSample);
        output.set(bytes.subarray((from - item.startSample) * 2, (to - item.startSample) * 2), (from - startSample) * 2);
      }
      return output;
    },

    status() {
      return { recordingId, committedBytes, claimCount: claims.length, highestEpoch,
        nextCaptureEpoch: highestEpoch + 1, tailState, openEpochs: [...new Set([...begunEpochs, ...claims.map((claim) => claim.captureEpoch)])]
          .filter((epoch) => !closedEpochs.has(epoch)) };
    },
    close() { segment?.close(); ledger?.close(); segment = null; ledger = null; openSegmentNumber = 0; }
  });
}

function validClaim(value) {
  return validPart(value.operationId) && Number.isSafeInteger(value.captureEpoch) && value.captureEpoch > 0
    && Number.isSafeInteger(value.startSample) && value.startSample >= 0
    && Number.isSafeInteger(value.endSample) && value.endSample > value.startSample
    && Number.isSafeInteger(value.segment) && value.segment > 0
    && Number.isSafeInteger(value.offset) && value.offset >= 0
    && Number.isSafeInteger(value.byteLength) && value.byteLength === (value.endSample - value.startSample) * 2
    && value.byteLength <= 32_000 && /^[a-f0-9]{64}$/.test(value.sha256);
}
