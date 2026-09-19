import { randomUUID } from 'node:crypto';
import { currentRequestOwnerId } from '../../server/requestIdentity.js';
import { createBackgroundJobMessage } from './backgroundJobs.js';
import { createExportApplicationService } from './exportApplicationService.js';
import { meetingExportSource } from '../lib/meetingExportSource.js';

export const EXPORT_FORMATS = Object.freeze(['txt', 'srt', 'vtt']);
export const EXPORT_STREAMS = Object.freeze(['source', 'translation', 'both']);
export const EXPORT_STATUSES = Object.freeze(['queued', 'processing', 'ready', 'failed', 'stale']);
export const EXPORT_MIME_TYPES = Object.freeze({
  txt: 'text/plain',
  srt: 'application/x-subrip',
  vtt: 'text/vtt'
});

export function createExportArtifactService({
  artifactRepository,
  sourceReader,
  queue,
  storage,
  exportApplicationService = createExportApplicationService(),
  idFactory = randomUUID,
  clock = () => Date.now(),
  ownerResolver = currentRequestOwnerId,
  maxAttempts = 3
} = {}) {
  assertRepository(artifactRepository);
  assertMethod(sourceReader, 'read', 'sourceReader');
  assertMethod(queue, 'enqueue', 'queue');
  assertMethod(storage, 'put', 'storage');
  assertMethod(storage, 'remove', 'storage');
  assertMethod(storage, 'createSignedUrl', 'storage');

  return Object.freeze({
    async create({ ownerUserId = ownerResolver(), meetingId, format, stream } = {}) {
      const input = validateInput({ ownerUserId, meetingId, format, stream });
      const source = await sourceReader.read(input);
      const existing = await artifactRepository.findByKey({
        ownerUserId: input.ownerUserId,
        meetingId: input.meetingId,
        sourceHash: source.sourceHash,
        format: input.format,
        stream: input.stream
      });

      if (existing?.status === 'ready' || existing?.status === 'queued' || existing?.status === 'processing') {
        return { artifact: toDTO(existing), accepted: existing.status !== 'ready' };
      }

      const fileName = buildFileName(input);
      const exportId = idFactory();
      const artifact = existing
        ? await artifactRepository.update(existing.id, input.ownerUserId, {
          status: 'queued',
          sourceHash: source.sourceHash,
          fileName,
          mimeType: EXPORT_MIME_TYPES[input.format],
          errorCode: null,
          updatedAt: new Date(clock()).toISOString()
        })
        : await artifactRepository.create({
          id: exportId,
          ownerUserId: input.ownerUserId,
          meetingId: input.meetingId,
          sourceHash: source.sourceHash,
          format: input.format,
          stream: input.stream,
          status: 'queued',
          fileName,
          mimeType: EXPORT_MIME_TYPES[input.format],
          storagePath: objectPath({ ownerUserId: input.ownerUserId, meetingId: input.meetingId, exportId, fileName }),
          createdAt: new Date(clock()).toISOString(),
          updatedAt: new Date(clock()).toISOString(),
          attempt: 0
        });

      await queue.enqueue(createBackgroundJobMessage({
        ownerUserId: input.ownerUserId,
        artifactId: artifact.id,
        meetingId: input.meetingId
      }));
      return { artifact: toDTO(artifact), accepted: true };
    },

    async list({ ownerUserId = ownerResolver(), meetingId } = {}) {
      validateOwner(ownerUserId);
      validateMeetingId(meetingId);
      return (await artifactRepository.listByMeeting({ ownerUserId, meetingId })).map(toDTO);
    },

    async get({ ownerUserId = ownerResolver(), meetingId, exportId } = {}) {
      validateOwner(ownerUserId);
      validateMeetingId(meetingId);
      validateId(exportId, 'exportId');
      const artifact = await artifactRepository.getById(exportId, ownerUserId, meetingId);
      if (!artifact) throw exportError('export_not_found', 404);
      return toDTO(artifact);
    },

    async createDownloadUrl({ ownerUserId = ownerResolver(), meetingId, exportId, expiresIn = 60 } = {}) {
      validateOwner(ownerUserId);
      validateMeetingId(meetingId);
      validateId(exportId, 'exportId');
      const artifact = await artifactRepository.getById(exportId, ownerUserId, meetingId);
      if (!artifact) throw exportError('export_not_found', 404);
      if (artifact.status !== 'ready') throw exportError('export_not_ready', 409);
      const signed = await storage.createSignedUrl({ path: artifact.storagePath, expiresIn });
      return {
        url: signed.url,
        expiresAt: signed.expiresAt,
        fileName: artifact.fileName,
        mimeType: artifact.mimeType
      };
    },

    async delete({ ownerUserId = ownerResolver(), meetingId, exportId } = {}) {
      validateOwner(ownerUserId);
      validateMeetingId(meetingId);
      validateId(exportId, 'exportId');
      const artifact = await artifactRepository.getById(exportId, ownerUserId, meetingId);
      if (!artifact) throw exportError('export_not_found', 404);
      await storage.remove({ path: artifact.storagePath });
      await artifactRepository.remove(exportId, ownerUserId, meetingId);
      return true;
    },

    async deleteMeeting({ ownerUserId = ownerResolver(), meetingId } = {}) {
      validateOwner(ownerUserId);
      validateMeetingId(meetingId);
      const artifacts = await artifactRepository.listByMeeting({ ownerUserId, meetingId });
      if (artifacts.length > 0) {
        await storage.remove({ paths: artifacts.map((artifact) => artifact.storagePath) });
        await artifactRepository.removeByMeeting({ ownerUserId, meetingId });
      }
      return artifacts.length;
    },

    async process({ ownerUserId, artifactId, meetingId } = {}) {
      validateOwner(ownerUserId);
      validateId(artifactId, 'artifactId');
      validateMeetingId(meetingId);
      const artifact = await artifactRepository.getById(artifactId, ownerUserId, meetingId);
      if (!artifact) return { status: 'missing', artifactId };
      const source = await sourceReader.read({ ownerUserId, meetingId });
      if (source.sourceHash !== artifact.sourceHash) {
        await artifactRepository.update(artifact.id, ownerUserId, {
          status: 'stale',
          errorCode: 'export_source_changed',
          updatedAt: new Date(clock()).toISOString()
        });
        return { status: 'stale', artifactId };
      }

      const attempt = Number(artifact.attempt || 0) + 1;
      await artifactRepository.update(artifact.id, ownerUserId, {
        status: 'processing',
        attempt,
        errorCode: null,
        updatedAt: new Date(clock()).toISOString()
      });
      try {
        const content = exportApplicationService.exportTranscript({
          items: source.items,
          cues: source.cues,
          options: {
            format: artifact.format,
            stream: artifact.stream,
            timeOrigin: source.timeOrigin
          }
        });
        const bytes = Buffer.from(String(content), 'utf8');
        await storage.put({ path: artifact.storagePath, bytes, contentType: EXPORT_MIME_TYPES[artifact.format] });
        await artifactRepository.update(artifact.id, ownerUserId, {
          status: 'ready',
          byteSize: bytes.byteLength,
          mimeType: EXPORT_MIME_TYPES[artifact.format],
          completedAt: new Date(clock()).toISOString(),
          updatedAt: new Date(clock()).toISOString(),
          errorCode: null
        });
        return { status: 'ready', artifactId };
      } catch (error) {
        await artifactRepository.update(artifact.id, ownerUserId, {
          status: attempt >= maxAttempts ? 'failed' : 'queued',
          attempt,
          errorCode: safeErrorCode(error),
          updatedAt: new Date(clock()).toISOString()
        });
        throw error;
      }
    }
  });
}

export function validateExportInput({ meetingId, format, stream } = {}) {
  validateMeetingId(meetingId);
  if (!EXPORT_FORMATS.includes(format)) throw exportError('export_invalid_format', 400);
  if (!EXPORT_STREAMS.includes(stream)) throw exportError('export_invalid_stream', 400);
  if ((format === 'srt' || format === 'vtt') && stream === 'both') throw exportError('export_invalid_stream', 400);
}

export function buildFileName({ meetingId, format, stream }) {
  validateExportInput({ meetingId, format, stream });
  return `live-translate-meeting-${safePathPart(meetingId)}-${format}-${stream}.${format}`;
}

export function objectPath({ ownerUserId, meetingId, exportId, fileName }) {
  validateOwner(ownerUserId);
  validateMeetingId(meetingId);
  validateId(exportId, 'exportId');
  return `${ownerUserId}/${meetingId}/${exportId}/${safeFileName(fileName)}`;
}

function validateInput(input) {
  validateOwner(input.ownerUserId);
  validateExportInput(input);
  return input;
}

function validateOwner(value) {
  if (typeof value !== 'string' || value.trim() === '') throw exportError('auth_required', 401);
}

function validateMeetingId(value) {
  if (typeof value !== 'string' || value.trim() === '') throw exportError('invalid_request', 400);
}

function validateId(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw exportError('invalid_request', 400, `${name} must be a non-empty string.`);
}

function safePathPart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/gu, '-');
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/gu, '-');
}

function toDTO(row) {
  return {
    id: row.id,
    meetingId: row.meetingId,
    format: row.format,
    stream: row.stream,
    status: row.status,
    fileName: row.fileName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.byteSize === undefined ? {} : { byteSize: Number(row.byteSize) || 0 }),
    ...(row.mimeType ? { mimeType: row.mimeType } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.attempt === undefined ? {} : { attempt: Number(row.attempt) || 0 })
  };
}

function assertRepository(repository) {
  for (const method of ['findByKey', 'create', 'getById', 'listByMeeting', 'update', 'remove', 'removeByMeeting']) assertMethod(repository, method, 'artifactRepository');
}

function assertMethod(target, method, owner) {
  if (!target || typeof target[method] !== 'function') throw new TypeError(`${owner}.${method} must be a function.`);
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[a-z0-9_:-]+$/u.test(error.code) ? error.code : 'export_failed';
}

function exportError(code, status, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
