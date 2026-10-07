import http from 'node:http';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LANGUAGES, isSupportedLanguage } from './languages.js';
import { createLiveToken, DEFAULT_LIVE_TRANSLATE_MODEL, safeGeminiProviderDiagnostic } from './tokenService.js';
import { createAccessControl, getBearerToken } from './accessControl.js';
import { createApplicationDependencies, createProductionApplicationDependencies, ensureDataDirectory } from './compositionRoot.js';
import { createSessionSnapshotSyncService } from '../src/application/sessionSnapshotSyncService.js';
import { createSessionShareService } from '../src/application/sessionShareService.js';
import { createSessionEventBroadcaster } from '../src/infrastructure/sessionEventBroadcaster.js';
import { createMeetingEventBroadcaster } from '../src/infrastructure/meetingEventBroadcaster.js';
import { createRecorderGrantService } from '../src/application/recorderGrantService.js';
import { createAdminService } from './adminService.js';
import { createAuditLogService } from './auditLogService.js';
import { authorizeRecorderRequest, hasRecorderHeaders } from '../src/application/recorderAuthorization.js';
import { attachExecutionEventsWebSocket } from './executionEventsWebSocket.js';
import { createTranslationExecutionMetrics } from '../src/application/translation/translationExecutionMetrics.js';
import { resolveSavedRetranslationModel } from '../src/infrastructure/geminiSavedTranscriptTranslationComposition.js';
import { mapSessionRecordDetailToDTO } from '../src/readModels/sessionReadModels.js';
import {
  audioArtifactDownloadByteLength,
  sanitizeAudioArtifactsForDTO,
  validateAudioArtifactKind
} from '../src/infrastructure/sessionAudioArtifacts.js';
import { composePcm16WavSegments as composeWavSegments } from '../src/lib/audio.js';
import { createProfileService } from './profileService.js';
import { cloudEnvironmentError } from './cloudEnvironment.js';
import { createMeetingMembershipService } from '../src/application/meetingMembershipService.js';
import { currentRequestActorId, currentRequestOwnerId, currentRequestScope, setRequestScope, setRequestUser, runWithRequestUser } from './requestIdentity.js';
import { validateViewerTelemetry } from '../src/application/observability/telemetry.js';
import { OBSERVABILITY_METRIC_NAMES, providerStatusClass } from '../src/application/observability/observabilityMetricRegistry.js';
import { createSupabaseObservabilityMetricRepository } from '../src/infrastructure/supabaseObservabilityMetricRepository.js';
import { createStructuredLogger } from '../src/infrastructure/structuredLogger.js';
import { createExportController } from './exportController.js';
import { isMeetingContentExpired, meetingContentExpiredError } from '../src/lib/meetingRetention.js';
import { createPublicRuntimeConfig } from './publicRuntimeConfig.js';

const IS_MAIN = process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (IS_MAIN && process.argv.includes('--production')) {
  process.env.NODE_ENV ??= 'production';
}

if (IS_MAIN) {
  loadDotenv();
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SERVER_HOST = IS_PRODUCTION ? '0.0.0.0' : '127.0.0.1';
const SERVER_PORT = IS_PRODUCTION ? 8000 : 3000;
const DIST_DIR = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const INDEX_HTML_PATH = join(DIST_DIR, 'index.html');
const rateLimitBuckets = new Map();

const ERROR_RESPONSES = {
  auth_required: { status: 401, message: 'Access token is required.' },
  auth_invalid: { status: 401, message: 'Access token is invalid.' },
  auth_forbidden: { status: 403, message: 'Access is not allowed.' },
  auth_not_configured: { status: 503, message: 'Access gate is not configured.' },
  cloud_capability_unavailable: { status: 503, message: 'This cloud capability is not enabled yet.' },
  supabase_unavailable: { status: 503, message: 'Local Supabase is unavailable.' },
  supabase_schema_missing: { status: 503, message: 'Local Supabase migrations are missing.' },
  supabase_storage_missing: { status: 503, message: 'Supabase Storage configuration is missing.' },
  supabase_credentials_invalid: { status: 503, message: 'Local Supabase service credentials are invalid.' },
  supabase_request_failed: { status: 503, message: 'Local Supabase request failed.' },
  profile_not_found: { status: 503, message: 'Authenticated account profile was not created.' },
  profile_activation_failed: { status: 503, message: 'Authenticated account profile could not be activated.' },
  account_not_disabled: { status: 409, message: 'Account is not disabled.' },
  account_not_found: { status: 404, message: 'Account was not found.' },
  invalid_account_role: { status: 400, message: 'Account role must be member or super_admin.' },
  cannot_demote_self: { status: 409, message: 'System administrators cannot demote their own account.' },
  last_super_admin: { status: 409, message: 'At least one system administrator must remain.' },
  invalid_json: { status: 400, message: 'Request body must be valid JSON.' },
  invalid_request: { status: 400, message: 'Request body or path parameters are invalid.' },
  invalid_origin: { status: 403, message: 'Request origin is not allowed.' },
  not_found: { status: 404, message: 'Route not found.' },
  glossary_entry_not_found: { status: 404, message: 'Glossary entry not found.' },
  glossary_category_not_found: { status: 404, message: 'Glossary category not found.' },
  glossary_category_duplicate: { status: 409, message: 'Glossary category label already exists.' },
  glossary_category_not_deletable: { status: 409, message: 'The other glossary category cannot be deleted.' },
  glossary_not_configured: { status: 503, message: 'Translation glossary is not configured.' },
  glossary_import_invalid: { status: 400, message: 'Glossary import contains invalid data.' },
  glossary_import_resolution_required: { status: 400, message: 'Glossary import requires conflict resolutions.' },
  glossary_revision_conflict: { status: 409, message: 'Glossary changed after the import preview.' },
  meeting_read_unavailable: { status: 503, message: 'Meeting read API is not configured.' },
  provider_unavailable: { status: 502, message: 'Live translation provider is unavailable.' },
  gemini_credential_not_configured: { status: 409, message: 'Set a Gemini API Key before starting a meeting.' },
  rate_limited: { status: 429, message: 'Too many requests. Please try again later.' },
  request_too_large: { status: 413, message: 'Request body is too large.' },
  server_misconfigured: { status: 500, message: 'Server is not configured for live translation.' },
  session_not_found: { status: 404, message: 'Session not found.' },
  audio_artifact_not_found: { status: 404, message: 'Audio artifact not found.' },
  audio_artifact_not_ready: { status: 409, message: 'Audio artifact is not ready.' },
  audio_mime_type_unsupported: { status: 400, message: 'Audio MIME type is not supported.' },
  realtime_required: { status: 410, message: 'Supabase Realtime is required for this Viewer.' },
  meeting_delete_active_not_allowed: { status: 409, message: 'Active meetings cannot be deleted.' },
  recorder_already_active: { status: 409, message: 'This Session is already being recorded by another device.' },
  recorder_lease_invalid: { status: 409, message: 'Recorder lease is invalid or expired.' },
  recorder_takeover_confirmation_required: { status: 409, message: 'Recorder takeover requires explicit owner confirmation.' },
  meeting_lifecycle_conflict: { status: 409, message: 'Meeting lifecycle changed before this operation completed.' },
  recorder_forbidden: { status: 403, message: 'Recorder capability is required.' },
  recorder_grant_invalid: { status: 409, message: 'Recorder grant is invalid or expired.' },
  recorder_session_mismatch: { status: 403, message: 'Recorder capability does not belong to this Session.' },
  saved_transcript_retranslation_unavailable: {
    status: 503,
    message: 'Saved transcript re-translation is not configured.'
  },
  unsupported_language: { status: 400, message: 'Selected target language is not supported.' },
  unsupported_live_session_mode: { status: 400, message: 'Selected Live session mode is not supported.' },
  translation_execution_not_found: { status: 404, message: 'Translation execution not found.' },
  translation_output_not_found: { status: 404, message: 'Translation output not found.' },
  translation_request_not_found: { status: 404, message: 'Translation request not found.' },
  execution_invalid_state: { status: 409, message: 'Translation execution is not in a valid state for this operation.' },
  checkpoint_conflict: { status: 409, message: 'Meeting checkpoint conflicts with previously persisted content.' },
  meeting_checkpoint_unavailable: { status: 503, message: 'Meeting checkpoint persistence is not configured.' },
  meeting_terminal: { status: 409, message: 'Meeting has already ended.' },
  meeting_content_expired: { status: 410, message: 'Meeting content retention period has expired.' },
  meeting_share_invalid: { status: 404, message: 'Meeting share is invalid or expired.' },
  meeting_not_found: { status: 404, message: 'Meeting not found.' },
  meeting_delete_not_allowed: { status: 409, message: 'Only meetings that have not started can be deleted.' },
  meeting_settings_locked: { status: 409, message: 'Completed meeting settings cannot be changed.' },
  meeting_share_locked: { status: 409, message: 'Completed meeting shares are read-only.' },
  meeting_complete_not_allowed: { status: 409, message: 'Meeting cannot be completed in its current state.' },
  meeting_segment_not_found: { status: 404, message: 'Meeting segment not found.' },
  meeting_segment_invalid_state: { status: 409, message: 'Meeting segment is not in a valid state for this operation.' },
  meeting_share_invalid: { status: 409, message: 'Meeting share is not available for recording.' },
  dead_letter_queue_unavailable: { status: 503, message: 'Dead-letter queue is not configured.' },
  dead_letter_item_not_found: { status: 404, message: 'Dead-letter queue item not found.' },
  subtitle_cue_invalid: { status: 400, message: 'Subtitle cue is invalid.' },
  subtitle_cue_conflict: { status: 409, message: 'Subtitle cue conflicts with previously persisted content.' },
  subtitle_cue_sequence_conflict: { status: 409, message: 'Subtitle cue sequence conflicts with previously persisted content.' },
  subtitle_cue_session_not_found: { status: 404, message: 'Subtitle cue session was not found.' },
  subtitle_cue_segment_not_found: { status: 404, message: 'Subtitle cue segment was not found.' },
  subtitle_cue_segment_session_mismatch: { status: 409, message: 'Subtitle cue segment does not belong to its session.' },
  internal_error: { status: 500, message: 'Unexpected server error.' }
};
const DELETABLE_SESSION_STATUSES = new Set(['completed', 'stopped', 'failed', 'expired']);
const DEFAULT_JSON_REQUEST_MAX_BYTES = 10_000;
const GLOSSARY_IMPORT_MAX_BYTES = 1 * 1024 * 1024;
const SESSION_SNAPSHOT_MAX_BYTES = parseByteLimit(process.env.SESSION_SNAPSHOT_MAX_BYTES, 25 * 1024 * 1024);
const TRANSLATION_OUTPUT_MAX_BYTES = parseByteLimit(process.env.TRANSLATION_OUTPUT_MAX_BYTES, 25 * 1024 * 1024);
const MEETING_CHECKPOINT_MAX_BYTES = parseByteLimit(process.env.MEETING_CHECKPOINT_MAX_BYTES, 25 * 1024 * 1024);
const MAX_AUDIO_ARTIFACT_BYTES = parseByteLimit(process.env.SESSION_AUDIO_MAX_BYTES, 50 * 1024 * 1024);

function safeTranslationProvidersFor(env = process.env) {
  return [
    {
      key: 'gemini',
      label: 'Gemini',
      provider: 'gemini',
      model: resolveSavedRetranslationModel(env)
    }
  ];
}

function sendJson(res, status, payload, requestId, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...(res.__validatedOrigin ? { 'Access-Control-Allow-Origin': res.__validatedOrigin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Name',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extraHeaders,
    ...(requestId ? { 'X-Request-Id': requestId } : {})
  });
  res.end(body);
}

function sendBinary(res, status, bytes, { contentType = 'application/octet-stream', fileName = 'download.bin', requestId } = {}) {
  const buffer = Buffer.from(bytes);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.byteLength,
    'Content-Disposition': `attachment; filename="${String(fileName).replace(/["\\]/g, '')}"`,
    ...(res.__validatedOrigin ? { 'Access-Control-Allow-Origin': res.__validatedOrigin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Name',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...(requestId ? { 'X-Request-Id': requestId } : {})
  });
  res.end(buffer);
}

function writeBinaryHeaders(res, status, { contentType = 'application/octet-stream', contentLength, fileName = 'download.bin', requestId } = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    ...(Number.isFinite(contentLength) ? { 'Content-Length': contentLength } : {}),
    'Content-Disposition': `attachment; filename="${String(fileName).replace(/["\\]/g, '')}"`,
    ...(res.__validatedOrigin ? { 'Access-Control-Allow-Origin': res.__validatedOrigin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Name',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...(requestId ? { 'X-Request-Id': requestId } : {})
  });
}

async function sendBinaryStream(res, status, stream, options = {}) {
  writeBinaryHeaders(res, status, options);
  for await (const chunk of stream) {
    if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
  }
  res.end();
}

async function readJson(req, { maxBytes = DEFAULT_JSON_REQUEST_MAX_BYTES } = {}) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) {
      const error = new Error('Request body too large');
      error.status = 413;
      error.code = 'request_too_large';
      throw error;
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks, byteLength).toString('utf8');
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    error.code = 'invalid_json';
    throw error;
  }
}

async function readBinary(req, { maxBytes = MAX_AUDIO_ARTIFACT_BYTES } = {}) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) {
      const error = new Error('Request body too large');
      error.status = 413;
      error.code = 'request_too_large';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, byteLength);
}

function parseByteLimit(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getRequestPath(req) {
  return req.url?.split('?')[0] || '/';
}

function getClientIp(req) {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().toLowerCase() === 'null') return '';
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return '';
    if (/\s/u.test(parsed.hostname)) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function normalizeVercelHostname(value) {
  if (typeof value !== 'string' || !value.trim() || /[/:?#\s]/u.test(value.trim())) return '';
  return normalizeOrigin(`https://${value.trim()}`);
}

export function resolveAllowedOrigins(env = process.env) {
  const origins = new Set();
  const appOrigin = normalizeOrigin(env.APP_ORIGIN);
  const vercelEnvironment = String(env.VERCEL_ENV || '').toLowerCase();

  if (vercelEnvironment === 'preview') {
    if (appOrigin) origins.add(appOrigin);
    for (const value of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
      const origin = normalizeVercelHostname(value);
      if (origin) origins.add(origin);
    }
    return origins;
  }

  if (vercelEnvironment === 'production' || env.NODE_ENV === 'production') {
    if (appOrigin) origins.add(appOrigin);
    if (!vercelEnvironment && !appOrigin) {
      const legacyVercelOrigin = normalizeVercelHostname(env.VERCEL_URL);
      if (legacyVercelOrigin) origins.add(legacyVercelOrigin);
    }
    return origins;
  }

  const localOrigin = normalizeOrigin(env.dev_frontend_origin) || appOrigin || 'http://127.0.0.1:5173';
  origins.add(localOrigin);
  return origins;
}

export function resolveAllowedOrigin(env = process.env) {
  return [...resolveAllowedOrigins(env)][0] || 'http://127.0.0.1:8000';
}

function isAllowedOrigin(req) {
  const rawOrigin = req.headers?.origin;
  if (!rawOrigin) return true;
  return resolveAllowedOrigins(process.env).has(rawOrigin);
}

function isProfileOnlyMode() {
  return process.env.P1_PROFILE_ONLY === 'true';
}

const globalAccessControl = createAccessControl();

function isAuthConfigured() {
  return globalAccessControl.isConfigured();
}

function enforceRateLimit(clientIp) {
  const now = Date.now();
  const windowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
  const maxRequests = Number.parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
  const bucket = rateLimitBuckets.get(clientIp);

  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(clientIp, { count: 1, resetAt: now + windowMs });
    return;
  }

  bucket.count += 1;
  if (bucket.count > maxRequests) {
    throw createHttpError('rate_limited');
  }
}

async function enrichAuthenticatedUser(user, profileService) {
  if (!user?.id || typeof profileService?.getProfile !== 'function') return user;
  const profile = await profileService.getProfile(user, { activatePending: true });
  if (profile?.status === 'disabled') throw createHttpError('auth_forbidden');
  if (profile?.status !== 'active') throw createHttpError('profile_activation_failed');
  return {
    ...user,
    role: profile?.role || user.role || 'member',
    status: profile?.status || user.status || 'active',
    profile,
  };
}

function createHttpError(code, details = null) {
  const template = ERROR_RESPONSES[code] || ERROR_RESPONSES.internal_error;
  const error = new Error(template.message);
  error.status = template.status;
  error.code = code;
  if (Array.isArray(details) && details.length > 0) error.details = details;
  return error;
}

function errorCodeFor(error) {
  if (error.code && ERROR_RESPONSES[error.code]) {
    return error.code;
  }

  if (error.message === 'Unsupported targetLanguageCode' || error.message === 'Unsupported sourceLanguageCode') {
    return 'unsupported_language';
  }
  if (error.message === 'GEMINI_API_KEY is not configured') {
    return 'server_misconfigured';
  }
  if (error.message === 'Failed to create Gemini ephemeral token') {
    return 'provider_unavailable';
  }

  return 'internal_error';
}

function errorPayload(code, requestId, details) {
  const template = ERROR_RESPONSES[code] || ERROR_RESPONSES.internal_error;
  return {
    error: {
      code,
      message: template.message,
      requestId,
      ...(Array.isArray(details) && details.length > 0 ? { details } : {})
    }
  };
}

const structuredLogger = createStructuredLogger({ service: 'live-translate-api' });

function logEvent(event) {
  structuredLogger.log(event);
}

function logProviderError(requestId, error, { hasSupabaseAccessToken = false, hasGeminiApiKey = false, geminiApiKeyLength = 0, model = DEFAULT_LIVE_TRANSLATE_MODEL, apiVersion = 'v1beta', logger = logEvent } = {}) {
  const cause = error.cause || error;
  const diagnostic = error.providerDiagnostic || safeGeminiProviderDiagnostic(cause);
  logger({
    level: 'error',
    event: 'gemini_token_provider_failure',
    requestId,
    stage: 'google_auth_token_request',
    deployment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    hasSupabaseAccessToken,
    hasGeminiApiKey,
    geminiApiKeyLength,
    model: diagnostic.model || model,
    apiVersion: diagnostic.apiVersion || apiVersion,
    status: diagnostic.status ?? null,
    code: diagnostic.code ?? null,
    category: diagnostic.category || 'unknown_provider_error',
    tokenCreated: false
  });
}

function safeRequestErrorSummary(error) {
  switch (error?.code) {
    case 'supabase_unavailable':
      return 'Supabase REST endpoint is unavailable.';
    case 'supabase_schema_missing':
      return 'Supabase schema or required table is missing.';
    case 'supabase_credentials_invalid':
      return 'Supabase service credentials are invalid.';
    case 'cloud_capability_unavailable':
      return 'Cloud capability is unavailable.';
    case 'auth_required':
      return 'Authentication is required.';
    case 'auth_invalid':
      return 'Authentication token is invalid.';
    case 'auth_forbidden':
      return 'Authenticated user is not allowed.';
    default:
      return error?.status >= 500 ? 'Internal request failure.' : 'Request rejected.';
  }
}

function supabaseProjectRef(env = process.env) {
  try {
    const hostname = new URL(String(env.SUPABASE_URL || '')).hostname;
    return hostname.endsWith('.supabase.co') ? hostname.slice(0, -'.supabase.co'.length) : null;
  } catch {
    return null;
  }
}

function safeSupabaseFailureDiagnostics(error) {
  return {
    supabaseStatus: Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null,
    supabaseCode: typeof error?.supabaseCode === 'string' ? error.supabaseCode : null,
    supabaseErrorClass: typeof error?.supabaseErrorClass === 'string' ? error.supabaseErrorClass : null,
    supabaseConstraint: typeof error?.supabaseConstraint === 'string' ? error.supabaseConstraint : null,
    supabaseResource: typeof error?.supabaseResource === 'string' ? error.supabaseResource : null,
    supabaseOperation: typeof error?.supabaseOperation === 'string' ? error.supabaseOperation : null,
    supabaseProjectRef: supabaseProjectRef()
  };
}

function meetingRequestDiagnostics({ operation = 'meeting.request', meetingId, authenticatedUser, statusCode, errorCode, supabaseStatus = null, resourceOwnerId, resourceOwnerKnown = false }) {
  return {
    operation,
    actorUserId: currentRequestActorId() || authenticatedUser?.actorUserId || authenticatedUser?.id || null,
    resourceOwnerUserId: resourceOwnerKnown
      ? resourceOwnerId || null
      : resourceOwnerId || currentRequestOwnerId() || authenticatedUser?.ownerUserId || null,
    resourceOwnerId: resourceOwnerKnown
      ? resourceOwnerId || null
      : resourceOwnerId || currentRequestOwnerId() || authenticatedUser?.ownerUserId || null,
    ...(meetingId ? { meetingId } : {}),
    statusCode,
    supabaseStatus: Number.isInteger(supabaseStatus) ? supabaseStatus : null,
    errorCode: errorCode || null,
    supabaseProjectRef: supabaseProjectRef()
  };
}

async function collectMeetingAuthorizationDiagnostics({ meetingId, authenticatedUser, profileService, meetingMembershipService }) {
  let resourceOwnerId = null;
  let ownerLookup = 'missing';
  try {
    resourceOwnerId = await meetingMembershipService?.getMeetingOwner?.(meetingId) || null;
    ownerLookup = resourceOwnerId ? 'found' : 'missing';
  } catch {
    ownerLookup = 'error';
  }

  let actorProfileStatus = null;
  let actorProfileRole = null;
  let actorProfileLookup = 'unavailable';
  try {
    if (typeof profileService?.getProfile === 'function') {
      const profile = await profileService.getProfile(authenticatedUser);
      actorProfileLookup = profile ? 'found' : 'missing';
      actorProfileStatus = profile?.status || null;
      actorProfileRole = profile?.role || null;
    }
  } catch {
    actorProfileLookup = 'error';
  }

  let membership = 'unavailable';
  try {
    if (typeof profileService?.findMeetingMembership === 'function') {
      membership = await profileService.findMeetingMembership(meetingId, authenticatedUser?.id)
        ? 'present'
        : 'absent';
    }
  } catch {
    membership = 'error';
  }

  return {
    resourceOwnerId,
    ownerLookup,
    ownerMatchesActor: resourceOwnerId && authenticatedUser?.id
      ? resourceOwnerId === authenticatedUser.id
      : null,
    actorProfileLookup,
    actorProfileStatus,
    actorProfileRole,
    membership
  };
}

function loadDotenv({ cwd = process.cwd(), env = process.env } = {}) {
  const nodeEnv = env.NODE_ENV || 'development';
  const originalKeys = new Set(Object.keys(env));
  for (const fileName of ['.env', `.env.${nodeEnv}`]) {
    loadDotenvFile(join(cwd, fileName), env, originalKeys);
  }
}

function loadDotenvFile(filePath, env, originalKeys) {
  if (!existsSync(filePath)) {
    return;
  }

  for (const [key, value] of parseDotenv(readFileSync(filePath, 'utf8'))) {
    if (!originalKeys.has(key)) {
      env[key] = value;
    }
  }
}

function parseDotenv(content) {
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    entries.push([key, parseDotenvValue(trimmed.slice(separatorIndex + 1).trim())]);
  }

  return entries;
}

function parseDotenvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const commentIndex = value.search(/\s#/);
  return commentIndex === -1 ? value : value.slice(0, commentIndex).trimEnd();
}

let defaultApplicationDependencies;

export function getDefaultApplicationDependencies() {
  if (defaultApplicationDependencies === undefined) {
    const createDefaultApplicationDependencies = selectDefaultApplicationDependenciesFactory({
      env: process.env
    });
    defaultApplicationDependencies = createDefaultApplicationDependencies({
      requestHandlerFactory: createRequestHandler,
      includeSessionRetranslationCommandController: true
    });
  }
  return defaultApplicationDependencies;
}

export function selectDefaultApplicationDependenciesFactory({ env = process.env } = {}) {
  return env.NODE_ENV === 'production' || hasConfiguredGeminiApiKey(env)
    ? createProductionApplicationDependencies
    : createApplicationDependencies;
}

function hasConfiguredGeminiApiKey(env) {
  return typeof env?.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 0;
}

export function startTranslationExecutionWorkerRuntime({
  translationExecutionWorkerRuntime,
  sessionRepository,
  translationExecutionQueue,
  logger = logEvent
} = {}) {
  if (translationExecutionWorkerRuntime === undefined || sessionRepository === undefined || translationExecutionQueue === undefined) {
    const defaults = getDefaultApplicationDependencies();
    translationExecutionWorkerRuntime ??= defaults.translationExecutionWorkerRuntime;
    sessionRepository ??= defaults.sessionRepository;
    translationExecutionQueue ??= defaults.translationExecutionQueue;
  }
  if (!translationExecutionWorkerRuntime || typeof translationExecutionWorkerRuntime.start !== 'function') {
    return () => undefined;
  }

  let isStopped = false;
  const startup = runWithRequestUser({ kind: 'worker' }, () => sessionRepository?.requiresRequestIdentity === true
    ? translationExecutionWorkerRuntime.start()
    : startRuntimeAfterPersistedQueueRecovery({
      translationExecutionWorkerRuntime,
      sessionRepository,
      translationExecutionQueue,
      logger
    }));
  Promise.resolve(startup).catch((error) => {
    logWorkerRuntimeError(logger, 'translation_execution_worker_runtime_start_failed', error);
  });

  return function stopTranslationExecutionWorkerRuntime() {
    if (isStopped || typeof translationExecutionWorkerRuntime.stop !== 'function') {
      return undefined;
    }

    isStopped = true;
    try {
      return translationExecutionWorkerRuntime.stop();
    } catch (error) {
      logWorkerRuntimeError(logger, 'translation_execution_worker_runtime_stop_failed', error);
      return undefined;
    }
  };
}

async function startRuntimeAfterPersistedQueueRecovery({
  translationExecutionWorkerRuntime,
  sessionRepository,
  translationExecutionQueue,
  logger
}) {
  try {
    await enqueuePersistedQueuedTranslationExecutions({
      sessionRepository,
      translationExecutionQueue
    });
  } catch (error) {
    logWorkerRuntimeError(logger, 'translation_execution_queue_recovery_failed', error);
  }

  await translationExecutionWorkerRuntime.start();
}

export async function enqueuePersistedQueuedTranslationExecutions({
  sessionRepository,
  translationExecutionQueue
} = {}) {
  if (
    !sessionRepository ||
    typeof sessionRepository.listSessionRecords !== 'function' ||
    !translationExecutionQueue ||
    typeof translationExecutionQueue.enqueue !== 'function'
  ) {
    return 0;
  }

  const records = await sessionRepository.listSessionRecords();
  let recoveredCount = 0;

  for (const record of Array.isArray(records) ? records : []) {
    const state = record?.translationCommandState;
    const requests = Array.isArray(state?.requests) ? state.requests : [];
    const executions = Array.isArray(state?.executions) ? state.executions : [];
    const outputs = Array.isArray(state?.outputs) ? state.outputs : [];

    for (const execution of executions) {
      if (execution?.status !== 'queued' || outputs.some((output) => output?.executionId === execution.id)) {
        continue;
      }

      const request = requests.find((candidate) => candidate?.id === execution.translationRequestId);
      if (!request) {
        continue;
      }

      await translationExecutionQueue.enqueue({
        executionId: execution.id,
        requestId: request.id
      });
      recoveredCount += 1;
    }
  }

  return recoveredCount;
}

function logWorkerRuntimeError(logger, event, error) {
  if (typeof logger !== 'function') {
    return;
  }

  logger({
    level: 'error',
    event,
    errorName: error?.name || 'Error',
    ...(error?.code ? { errorCode: error.code } : {}),
    ...(Number.isInteger(error?.status) ? { errorStatus: error.status } : {}),
    safeSummary: safeWorkerRuntimeSummary(error)
  });
}

function safeWorkerRuntimeSummary(error) {
  switch (error?.code) {
    case 'supabase_unavailable': return 'Supabase REST endpoint is unavailable';
    case 'supabase_schema_missing': return 'Supabase migration or required table is missing';
    case 'supabase_credentials_invalid': return 'Supabase service credentials are invalid';
    case 'auth_required': return 'Worker owner context is missing';
    default: return 'Translation execution worker runtime failed';
  }
}

export function createRequestHandler(options = {}) {
  const {
    sessionReadController,
    sessionRepository,
    translationRepository,
    translationCommandController,
    executionControlController,
    deadLetterQueueController,
    translationHistoryController,
    meetingRepository,
    meetingReadController,
 meetingCheckpointService,
 meetingDeletionService,
 meetingMembershipService,
    sessionAudioArtifactRepository,
    meetingAudioService,
  meetingCueService,
  meetingEventRepository,
    viewerRealtimeTokenService,
    sessionApplicationService,
    translationProviderOptionsController,
    glossaryController,
    savedTranscriptRetranslationController,
    sessionRetranslationCommandController,
    translationExecutionWorkerRuntime,
    meetingPurgeWorker,
    exportArtifactService,
    liveTokenCreator = createLiveToken,
    sessionSnapshotMaxBytes = SESSION_SNAPSHOT_MAX_BYTES,
    translationOutputMaxBytes = TRANSLATION_OUTPUT_MAX_BYTES,
    sessionShareService = createSessionShareService(),
    recorderLeaseService,
    recorderGrantService = createRecorderGrantService(),
    sessionEventBroadcaster = createSessionEventBroadcaster(),
    meetingEventBroadcaster = createMeetingEventBroadcaster(),
    executionEventBroadcaster,
    meetingCheckpointMaxBytes = MEETING_CHECKPOINT_MAX_BYTES,
    sessionAudioMaxBytes = MAX_AUDIO_ARTIFACT_BYTES,
    translationExecutionMetrics = createTranslationExecutionMetrics()
    , accessControl: requestAccessControl = globalAccessControl
    , profileService = createProfileService()
    , adminService = createAdminService({ auditLogService: createAuditLogService() })
    , meetingMembershipService: injectedMeetingMembershipService
 , authEventAuditLogService = createAuditLogService()
    , observabilityMetricRepository = createSupabaseObservabilityMetricRepository()
    , observabilityMetrics
  , readinessCheck
 , strictCheckpointPathIds = true
 , requestLogger = logEvent
 , publicRuntimeConfig = createPublicRuntimeConfig(process.env)
 } = options;

 const resolvedMeetingMembershipService = meetingMembershipService || injectedMeetingMembershipService || createMeetingMembershipService({
   profileRepository: { getProfile: (userId) => profileService.getProfile({ id: userId }) },
   membershipRepository: {
     find: ({ meetingId, userId }) => profileService.findMeetingMembership(meetingId, userId),
     list: ({ meetingId, actor }) => profileService.listMeetingMembers(actor, meetingId),
   },
   meetingRepository,
   sessionRepository,
 });

  if (Object.prototype.hasOwnProperty.call(options, 'translationCommandController')) {
    assertTranslationCommandController(translationCommandController);
  }
  if (Object.prototype.hasOwnProperty.call(options, 'executionControlController')) {
    assertExecutionControlController(executionControlController);
  }

  return async function handleRequestWithDependencies(req, res) {
    return handleRequestWithSessionReadController(req, res, {
      sessionReadController,
      sessionRepository,
      translationRepository,
      translationCommandController,
      executionControlController,
      deadLetterQueueController,
      translationHistoryController,
      meetingRepository,
      meetingReadController,
 meetingCheckpointService,
 meetingDeletionService,
 meetingMembershipService: resolvedMeetingMembershipService,
      sessionAudioArtifactRepository,
      meetingAudioService,
      meetingCueService,
      meetingEventRepository,
      viewerRealtimeTokenService,
      ...(sessionApplicationService !== undefined ? { sessionApplicationService } : {}),
      translationProviderOptionsController,
      glossaryController,
      savedTranscriptRetranslationController,
      sessionRetranslationCommandController,
    translationExecutionWorkerRuntime,
    meetingPurgeWorker,
    exportArtifactService,
      liveTokenCreator,
      sessionShareService,
    translationOutputMaxBytes,
    recorderLeaseService,
    meetingLifecycleService: options.meetingLifecycleService,
    recorderGrantService,
      sessionEventBroadcaster,
      meetingEventBroadcaster,
      sessionSnapshotMaxBytes,
      meetingCheckpointMaxBytes,
      sessionAudioMaxBytes,
      translationExecutionMetrics
      , observabilityMetricRepository
      , observabilityMetrics
      , readinessCheck
      , accessControl: requestAccessControl
      , profileService
      , adminService
      , authEventAuditLogService
 , strictCheckpointPathIds
 , requestLogger
 , publicRuntimeConfig
    });
  };
}

export async function handleRequest(req, res) {
  return getDefaultApplicationDependencies().requestHandler(req, res);
}

async function handleRequestWithSessionReadController(
  req,
  res,
 { sessionReadController, sessionRepository, sessionApplicationService, translationRepository, translationCommandController, executionControlController, deadLetterQueueController, translationHistoryController, meetingReadController, meetingCheckpointService, meetingDeletionService, meetingRepository, sessionAudioArtifactRepository, meetingAudioService, meetingCueService, viewerRealtimeTokenService, translationProviderOptionsController, glossaryController, savedTranscriptRetranslationController, sessionRetranslationCommandController, translationExecutionWorkerRuntime, liveTokenCreator = createLiveToken, sessionSnapshotMaxBytes = SESSION_SNAPSHOT_MAX_BYTES, translationOutputMaxBytes = TRANSLATION_OUTPUT_MAX_BYTES, sessionShareService = createSessionShareService(), recorderLeaseService, recorderGrantService = createRecorderGrantService(), sessionEventBroadcaster = createSessionEventBroadcaster(), meetingEventBroadcaster = (IS_PRODUCTION ? null : createMeetingEventBroadcaster()), executionEventBroadcaster, meetingCheckpointMaxBytes = MEETING_CHECKPOINT_MAX_BYTES, sessionAudioMaxBytes = MAX_AUDIO_ARTIFACT_BYTES, translationExecutionMetrics = createTranslationExecutionMetrics(), accessControl: requestAccessControl = globalAccessControl, profileService = createProfileService(), authEventAuditLogService = createAuditLogService(), adminService = createAdminService({ auditLogService: createAuditLogService() }), strictCheckpointPathIds = true } = {}
) {
  const exportArtifactService = arguments[2]?.exportArtifactService;
  const meetingEventRepository = arguments[2]?.meetingEventRepository;
  const meetingMembershipService = arguments[2]?.meetingMembershipService;
  const meetingLifecycleService = arguments[2]?.meetingLifecycleService;
  const meetingPurgeWorker = arguments[2]?.meetingPurgeWorker;
  const observabilityMetricRepository = arguments[2]?.observabilityMetricRepository;
  const observabilityMetrics = arguments[2]?.observabilityMetrics;
  const requestLogger = arguments[2]?.requestLogger || logEvent;
  const publicRuntimeConfig = arguments[2]?.publicRuntimeConfig || createPublicRuntimeConfig();
  const requestId = req.headers?.['x-request-id'] || crypto.randomUUID();
  const startedAt = performance.now();
  const path = getRequestPath(req);
  if (path === '/api/live-token') res.setHeader?.('Cache-Control', 'no-store');
  const clientIp = getClientIp(req);
  const origin = req.headers?.origin || '';
  res.__validatedOrigin = origin && isAllowedOrigin(req) ? origin : '';
  let authenticatedUser = null;
  let requestScope = null;
  const updateRequestScope = (resourceOwnerUserId = null) => {
    if (!requestScope) return;
    requestScope = Object.freeze({ ...requestScope, resourceOwnerUserId: resourceOwnerUserId || requestScope.actorUserId });
    setRequestScope(requestScope);
  };
  let statusCode = 500;
  let targetLanguageCode;
  let meetingDiagnosticId = null;
  let meetingDiagnosticErrorCode = null;
  let meetingDiagnosticSupabaseStatus = null;
  const meetingPathMatch = path.match(/^\/api\/meetings\/([^/]+)/u);
  if (meetingPathMatch && meetingPathMatch[1] !== 'glossary') {
    meetingDiagnosticId = safeDecodePathComponent(meetingPathMatch[1]);
  }
  setRequestUser(null);

  if (req.method === 'OPTIONS') {
    statusCode = 204;
    sendJson(res, statusCode, {}, requestId);
    return;
  }

  if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
    statusCode = 200;
    sendJson(res, statusCode, { ok: true, requestId }, requestId);
    return;
  }

  if (req.method === 'GET' && path === '/api/runtime-config') {
    statusCode = 200;
    sendJson(res, statusCode, publicRuntimeConfig, requestId, { 'Cache-Control': 'no-store' });
    return;
  }

  if (req.method === 'GET' && path === '/readyz') {
    const environmentError = cloudEnvironmentError({ requireBrowserConfig: IS_PRODUCTION });
    const hasSupabase = !environmentError;
    const legacyLocalReady = process.env.NODE_ENV !== 'production' && Boolean(process.env.GEMINI_API_KEY);
    let ready = hasSupabase || legacyLocalReady;
    let dependencyCode = environmentError?.code || null;
    if (ready && typeof readinessCheck === 'function') {
      try { ready = Boolean(await readinessCheck()); } catch (error) { ready = false; dependencyCode = error?.code || 'supabase_unavailable'; }
    }
    statusCode = ready ? 200 : 503;
    sendJson(res, statusCode, ready ? { ok: true, requestId } : { ok: false, error: { code: dependencyCode || 'supabase_unavailable' }, requestId }, requestId);
    return;
  }

  if (IS_PRODUCTION && path.startsWith('/api/') && cloudEnvironmentError({ requireBrowserConfig: true })) {
    statusCode = 503;
    logEvent({
      level: 'error',
      event: 'request_rejected',
      requestId,
      method: req.method,
      path,
      statusCode,
      errorCode: 'cloud_capability_unavailable',
      safeSummary: 'Production cloud environment is not ready.',
      durationMs: Math.round(performance.now() - startedAt),
      clientIp,
      origin
    });
    sendJson(res, statusCode, errorPayload('cloud_capability_unavailable', requestId), requestId);
    return;
  }

  if (path.startsWith('/api/') && !isPublicApiPath(req.method, path) && !isRecorderAuthorizedPath(req.method, path, req)) {
    try {
      if (!isAllowedOrigin(req)) throw createHttpError('invalid_origin');
      authenticatedUser = await requestAccessControl.validateRequest(req);
      setRequestUser(authenticatedUser);
      if (authenticatedUser?.id) {
        requestScope = Object.freeze({ actorUserId: authenticatedUser.id, resourceOwnerUserId: authenticatedUser.id, accessToken: getBearerToken(req), capability: 'user' });
        setRequestScope(requestScope);
      }
      authenticatedUser = await enrichAuthenticatedUser(authenticatedUser, profileService);
      setRequestUser(authenticatedUser);
      setRequestScope(requestScope);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      meetingDiagnosticSupabaseStatus = Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null;
      if (meetingDiagnosticId) {
        const authorizationDiagnostics = await collectMeetingAuthorizationDiagnostics({
          meetingId: meetingDiagnosticId,
          authenticatedUser,
          profileService,
          meetingMembershipService
        });
        requestLogger({
          level: statusCode >= 500 ? 'error' : 'warn',
          event: 'meeting_request',
          operation: `${req.method} ${path}`,
          requestId,
          method: req.method,
          path,
          statusCode,
          durationMs: Math.round(performance.now() - startedAt),
          clientIp,
          origin,
          authStage: 'authentication',
          ...meetingRequestDiagnostics({
            operation: `${req.method} ${path}`,
            meetingId: meetingDiagnosticId,
            authenticatedUser,
            statusCode,
            errorCode: code,
            supabaseStatus: meetingDiagnosticSupabaseStatus,
            resourceOwnerId: authorizationDiagnostics.resourceOwnerId,
            resourceOwnerKnown: true
          }),
          ...authorizationDiagnostics
        });
      }
      logEvent({
        level: statusCode >= 500 ? 'error' : 'warn',
        event: 'request_rejected',
        requestId,
        method: req.method,
        path,
        statusCode,
        errorCode: code,
        safeSummary: safeRequestErrorSummary(error),
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin
      });
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
      return;
    }
  }

  if (path.startsWith('/api/') && isProfileOnlyMode() && !['/api/profile', '/api/live-token', '/api/auth-events'].includes(path)) {
    statusCode = 503;
    logEvent({
      level: 'error',
      event: 'request_rejected',
      requestId,
      method: req.method,
      path,
      statusCode,
      errorCode: 'cloud_capability_unavailable',
      safeSummary: 'Cloud capability is disabled by profile-only mode.',
      durationMs: Math.round(performance.now() - startedAt),
      clientIp,
      origin
    });
    sendJson(res, statusCode, errorPayload('cloud_capability_unavailable', requestId), requestId);
    return;
  }

  if (req.method === 'GET' && path === '/api/metrics') {
    try {
      statusCode = 200;
      sendJson(res, statusCode, { ...translationExecutionMetrics.snapshot(), requestId }, requestId);
    } catch (error) {
      statusCode = 500;
      sendJson(res, statusCode, errorPayload('internal_error', requestId), requestId);
    }
    return;
  }

  if (req.method === 'POST' && isSharedMeetingTelemetryPath(path)) {
    try {
      enforceRateLimit(`${clientIp}:${path}`);
      const share = await resolveSharedMeeting(path, sessionShareService);
      if (!share || share.resourceType !== 'meeting' || share.role !== 'viewer') throw createHttpError('meeting_share_invalid');
      if (share._ownerUserId) setRequestUser({ id: share._ownerUserId });
      if (isMeetingContentExpired(await meetingRepository?.getMeeting(share.meetingId))) throw meetingContentExpiredError();
      const telemetry = validateViewerTelemetry(await readJson(req, { maxBytes: 2_000 }));
      if (observabilityMetrics || observabilityMetricRepository) {
        const metric = {
          reconnect: OBSERVABILITY_METRIC_NAMES.VIEWER_RECONNECT,
          event_gap: OBSERVABILITY_METRIC_NAMES.VIEWER_GAP,
          event_duplicate: OBSERVABILITY_METRIC_NAMES.VIEWER_DUPLICATE,
          replay_success: OBSERVABILITY_METRIC_NAMES.VIEWER_REPLAY_SUCCESS,
          replay_failure: OBSERVABILITY_METRIC_NAMES.VIEWER_REPLAY_FAILURE
        }[telemetry.eventType];
        try {
          if (observabilityMetrics) observabilityMetrics.recordCounter(metric, telemetry.count, { operation: 'viewer', provider: 'none', statusClass: 'none' }, telemetry.timestampBucket);
          else await observabilityMetricRepository.recordCounter(metric, { operation: 'viewer', provider: 'none', statusClass: 'none' }, telemetry.count, telemetry.timestampBucket);
        } catch (error) {
          logEvent({ level: 'warn', event: 'observability_metrics_write_failed', requestId, statusClass: 'other', safeSummary: 'Viewer telemetry persistence failed' });
        }
      }
      statusCode = 202;
      sendJson(res, statusCode, { accepted: true, requestId }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 400;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'DELETE' && path === '/api/test/sessions' && process.env.NODE_ENV === 'test') {
    try {
      for (const record of await sessionRepository.listSessionRecords()) {
        await sessionAudioArtifactRepository?.deleteMany?.(record.audioArtifacts);
        await sessionRepository.deleteSessionRecord(record.id);
      }
      statusCode = 204;
      sendJson(res, statusCode, {}, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId, error.details), requestId);
    }
    return;
  }

  if (isDeadLetterQueueRoute(req.method, path)) {
    try {
      if (!deadLetterQueueController) throw createHttpError('dead_letter_queue_unavailable');
      if (req.method === 'GET') {
        statusCode = 200;
        sendJson(res, statusCode, await deadLetterQueueController.listItems(), requestId);
      } else {
        const executionId = extractDeadLetterExecutionId(path);
        statusCode = 202;
        sendJson(res, statusCode, serializeDeadLetterReplayResponse(await deadLetterQueueController.replayItem({ executionId })), requestId);
      }
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId, error.details), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (path.startsWith('/api/') && !isPublicApiPath(req.method, path) && !isRecorderAuthorizedPath(req.method, path, req)) {
    try {
      if (!isAllowedOrigin(req)) throw createHttpError('invalid_origin');
      authenticatedUser = await requestAccessControl.validateRequest(req);
      setRequestUser(authenticatedUser);
      if (authenticatedUser?.id) {
        requestScope = Object.freeze({ actorUserId: authenticatedUser.id, resourceOwnerUserId: authenticatedUser.id, accessToken: getBearerToken(req), capability: 'user' });
        setRequestScope(requestScope);
      }
      authenticatedUser = await enrichAuthenticatedUser(authenticatedUser, profileService);
      setRequestUser(authenticatedUser);
      setRequestScope(requestScope);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
      return;
    }
  }

if (req.method === 'POST' && path === '/api/auth-events') {
 try {
  enforceRateLimit(`${clientIp}:auth-events`);
  if (!isAllowedOrigin(req)) throw createHttpError('invalid_origin');
  const authUser = await requestAccessControl.validateRequest(req);
  if (!authUser?.id) throw createHttpError('auth_required');
  const body = await readJson(req, { maxBytes: 4 * 1024 });
  if (body?.event !== 'login') throw createHttpError('invalid_request');
  const profile = await profileService.getProfile(authUser, { activatePending: true });
  const result = profile?.status === 'active' ? 'success' : 'failure';
  try {
   await authEventAuditLogService?.record({ actor_user_id: authUser.id, action: 'auth_login', result, request_id: requestId });
  } catch {
   logEvent({ level: 'warn', event: 'audit_write_failed', action: 'auth_login', result, requestId, safeSummary: 'Login audit write failed.' });
  }
  statusCode = 202;
  sendJson(res, statusCode, { accepted: true, requestId }, requestId);
 } catch (error) {
  const code = errorCodeFor(error);
  statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
  sendJson(res, statusCode, errorPayload(code, requestId), requestId);
 }
 return;
}

if (authenticatedUser && meetingMembershipService && !hasRecorderHeaders(req)) {
      let authorizationStage = 'private_resource';
      try {
        const scope = await authorizePrivateResource({ req, path, user: authenticatedUser, meetingMembershipService, meetingDeletionService, meetingRepository, profileService, sessionRepository });
    if (scope) {
      setRequestUser({ ...authenticatedUser, ...scope, actorUserId: authenticatedUser.id });
      updateRequestScope(scope.ownerUserId);
    }
    authorizationStage = 'translation_resource';
    const translationScope = await authorizeTranslationResource({ req, path, user: authenticatedUser, meetingMembershipService, translationRepository, meetingRepository });
    if (translationScope) {
      setRequestUser({ ...authenticatedUser, ...translationScope, actorUserId: authenticatedUser.id });
      updateRequestScope(translationScope.ownerUserId);
    }
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      meetingDiagnosticSupabaseStatus = Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null;
      if (meetingDiagnosticId) {
      const authorizationDiagnostics = await collectMeetingAuthorizationDiagnostics({
        meetingId: meetingDiagnosticId,
        authenticatedUser,
        profileService,
        meetingMembershipService
      });
      requestLogger({
        level: statusCode >= 500 ? 'error' : 'warn',
        event: 'meeting_request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin,
        authStage: authorizationStage,
        ...meetingRequestDiagnostics({
          operation: `${req.method} ${path}`,
          meetingId: meetingDiagnosticId,
          authenticatedUser,
          statusCode,
          errorCode: code,
          supabaseStatus: meetingDiagnosticSupabaseStatus,
          resourceOwnerId: authorizationDiagnostics.resourceOwnerId,
          resourceOwnerKnown: true
        }),
        ...authorizationDiagnostics
      });
    }
    sendJson(res, statusCode, errorPayload(code, requestId), requestId);
        return;
      }
    }

    if (authenticatedUser?.role === 'member' && !hasRecorderHeaders(req) && (isMemberMeetingRecordingPath(req.method, path) || isMemberSessionRecordingPath(req.method, path))) {
      try {
        const sessionContext = isMemberSessionRecordingPath(req.method, path)
          ? await meetingMembershipService?.getSessionOwner?.(extractSessionRecordingId(path))
          : null;
        const localSession = !sessionContext && isMemberSessionRecordingPath(req.method, path)
          ? await sessionRepository?.getSessionRecord?.(extractSessionRecordingId(path))
          : null;
        const meetingId = sessionContext?.meetingId || localSession?.sessionRecord?.meetingId || extractMemberMeetingId(path);
        if (!await meetingMembershipService?.canRecord?.(meetingId, authenticatedUser.id)) throw createHttpError('recorder_forbidden');
        const ownerUserId = sessionContext?.ownerUserId || localSession?.sessionRecord?.ownerUserId || await meetingMembershipService?.getMeetingOwner?.(meetingId);
 if (!ownerUserId) throw createHttpError('recorder_forbidden');
      setRequestUser({ ...authenticatedUser, ownerUserId, actorUserId: authenticatedUser.id });
      updateRequestScope(ownerUserId);
 } catch (error) {
 const code = errorCodeFor(error);
 statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
 sendJson(res, statusCode, errorPayload(code, requestId), requestId);
 return;
 }
 }

 if (req.method === 'GET' && path === '/api/profile') {
    try {
      statusCode = 200;
      sendJson(res, statusCode, { profile: await profileService.getProfile(authenticatedUser) }, requestId);
    } catch (error) {
      statusCode = 503;
      sendJson(res, statusCode, errorPayload('cloud_capability_unavailable', requestId), requestId);
    }
 return;
 }

if (path === '/api/admin/users' || path === '/api/admin/audit-logs' || /^\/api\/admin\/users\/[^/]+\/(enable|disable|role)$/u.test(path)) {
 try {
 if (authenticatedUser?.role !== 'super_admin' || authenticatedUser?.status !== 'active') throw createHttpError('auth_forbidden');
 if (!adminService) throw createHttpError('cloud_capability_unavailable');
    if (req.method === 'GET' && path === '/api/admin/audit-logs') {
      const url = new URL(req.url || '/', 'http://localhost');
      const page = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('pageSize') || 25);
      const action = url.searchParams.get('action') || 'all';
      const result = url.searchParams.get('result') || 'all';
      const query = url.searchParams.get('query') || '';
      statusCode = 200;
      sendJson(res, statusCode, await adminService.listAuditLogs(authenticatedUser, { page, pageSize, action, result, query }), requestId);
    } else if (req.method === 'GET' && path === '/api/admin/users') {
      const url = new URL(req.url || '/', 'http://localhost');
      const page = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('pageSize') || 12);
      const query = url.searchParams.get('query') || '';
      const status = url.searchParams.get('status') || 'all';
      if (!Number.isInteger(page) || page < 1 || ![12, 24, 48].includes(pageSize) || !['all', 'active', 'disabled'].includes(status) || query.length > 100) throw createHttpError('invalid_request');
      statusCode = 200;
      sendJson(res, statusCode, await adminService.listUsers(authenticatedUser, { page, pageSize, query, status }), requestId);
 } else if (req.method === 'PATCH' && /^\/api\/admin\/users\/[^/]+\/role$/u.test(path)) {
 const match = path.match(/^\/api\/admin\/users\/([^/]+)\/role$/u);
 const userId = safeDecodePathComponent(match[1]);
 const body = await readJson(req, { maxBytes: 8 * 1024 });
 const result = await adminService.updateUserRole(authenticatedUser, userId, body?.role, requestId);
 statusCode = 200;
 sendJson(res, statusCode, result, requestId);
 } else if (req.method === 'POST') {
 const match = path.match(/^\/api\/admin\/users\/([^/]+)\/(enable|disable)$/u);
 if (!match) throw createHttpError('invalid_request');
 const userId = safeDecodePathComponent(match[1]);
 const result = match[2] === 'enable'
 ? await adminService.enableUser(authenticatedUser, userId, requestId)
 : await adminService.disableUser(authenticatedUser, userId, (await readJson(req, { maxBytes: 16 * 1024 }))?.transferToUserId, requestId);
 statusCode = 200;
 sendJson(res, statusCode, { user: result }, requestId);
 } else {
 throw createHttpError('invalid_request');
 }
 } catch (error) {
 const code = errorCodeFor(error);
 statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
 sendJson(res, statusCode, errorPayload(code, requestId), requestId);
 }
 return;
 }

  if ((req.method === 'GET' || req.method === 'POST') && /^\/api\/meetings\/[^/]+\/members$/u.test(path)) {
    try {
      if (typeof profileService?.listMeetingMembers !== 'function') throw createHttpError('cloud_capability_unavailable');
      const meetingId = safeDecodePathComponent(path.split('/')[3]);
      if (!await meetingRepository?.getMeeting?.(meetingId)) throw createHttpError('meeting_not_found');
      const members = req.method === 'GET'
          ? await profileService.listMeetingMembers(authenticatedUser, meetingId)
          : [await profileService.addMeetingMember(authenticatedUser, meetingId, (await readJson(req, { maxBytes: 8 * 1024 }))?.email?.trim(), requestId)];
      statusCode = req.method === 'GET' ? 200 : 201;
      sendJson(res, statusCode, { members }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'DELETE' && /^\/api\/meetings\/[^/]+\/members\/[^/]+$/u.test(path)) {
    try {
      if (typeof profileService?.removeMeetingMember !== 'function') throw createHttpError('cloud_capability_unavailable');
      const parts = path.split('/');
      const meetingId = safeDecodePathComponent(parts[3]);
      const memberId = safeDecodePathComponent(parts[5]);
      if (!await meetingRepository?.getMeeting?.(meetingId)) throw createHttpError('meeting_not_found');
        await profileService.removeMeetingMember(authenticatedUser, meetingId, memberId, requestId);
      statusCode = 204;
      res.writeHead(statusCode, { 'X-Request-Id': requestId });
      res.end();
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'PATCH' && /^\/api\/meetings\/[^/]+\/members\/[^/]+$/u.test(path)) {
    try {
      if (typeof profileService?.updateMeetingMemberRecording !== 'function') throw createHttpError('cloud_capability_unavailable');
      const parts = path.split('/');
      const meetingId = safeDecodePathComponent(parts[3]);
      const memberId = safeDecodePathComponent(parts[5]);
      if (!await meetingRepository?.getMeeting?.(meetingId)) throw createHttpError('meeting_not_found');
      const body = await readJson(req, { maxBytes: 8 * 1024 });
      const member = await profileService.updateMeetingMemberRecording(authenticatedUser, meetingId, memberId, body?.canRecord, requestId);
      statusCode = 200;
      sendJson(res, statusCode, { member }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'GET' && path === '/api/sessions') {
    try {
      const sessions = sessionApplicationService
        ? await sessionApplicationService.listSessions()
        : await sessionReadController.listSessions();
      statusCode = 200;
      sendJson(res, statusCode, sessions, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin
      });
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/sessions') {
    let sessionCreateError = null;
    try {
      const body = await readJson(req);
      if (authenticatedUser?.role === 'member' && !body?.meetingId) throw createHttpError('recorder_forbidden');
      if (body?.meetingId) {
        if (!await meetingMembershipService?.canRecord?.(body.meetingId, authenticatedUser.id)) throw createHttpError('recorder_forbidden');
        const ownerUserId = await meetingMembershipService?.getMeetingOwner?.(body.meetingId);
        if (!ownerUserId) throw createHttpError('recorder_forbidden');
        setRequestUser({ ...authenticatedUser, ownerUserId, actorUserId: authenticatedUser.id });
        updateRequestScope(ownerUserId);
      }
      if (body?.targetLanguageCode && !isSupportedLanguage(body.targetLanguageCode)) {
        throw createHttpError('unsupported_language');
      }
      const sessionInput = {
        id: body?.id,
        name: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : null,
        meetingId: body?.meetingId || null,
        segmentId: body?.segmentId || null,
        targetLanguageCode: body?.targetLanguageCode || 'en',
        targetLanguageLabel: body?.targetLanguageLabel || null,
        sourceLanguageCode: body?.sourceLanguageCode || null,
        echoTargetLanguage: body?.echoTargetLanguage !== false,
        shouldRecordInputAudio: body?.shouldRecordInputAudio === true,
        ...(Object.hasOwn(body || {}, 'meetingGlossaryEntries')
          ? { meetingGlossaryEntries: Array.isArray(body.meetingGlossaryEntries) ? body.meetingGlossaryEntries : [] }
          : {}),
        selectedInputDeviceId: body?.selectedInputDeviceId || null,
        inputDeviceLabelSnapshot: body?.inputDeviceLabelSnapshot || null,
        status: 'created',
        startedAt: null
      };
      const session = sessionApplicationService
        ? await sessionApplicationService.createSession(sessionInput)
        : await sessionRepository.createSessionRecord(sessionInput);
      statusCode = 201;
      sendJson(res, statusCode, { session }, requestId);
    } catch (error) {
      sessionCreateError = error;
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      const errorCode = sessionCreateError ? errorCodeFor(sessionCreateError) : null;
      logEvent({
        level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
        event: 'session_create',
        requestId,
        method: req.method,
        path,
        statusCode,
        errorCode,
        supabaseStatus: Number.isInteger(sessionCreateError?.supabaseStatus) ? sessionCreateError.supabaseStatus : null,
        safeSummary: sessionCreateError ? safeRequestErrorSummary(sessionCreateError) : null,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin
      });
    }
    return;
  }

  if (req.method === 'POST' && isSessionShareCollectionPath(path)) {
    try {
      const sessionId = decodeSessionPath(path, '/api/sessions/', '/shares');
      const existing = await sessionRepository.getSessionRecord(sessionId);
      if (!existing?.sessionRecord) throw createHttpError('session_not_found');
      if (['active', 'paused', 'reconnecting'].includes(existing.sessionRecord.status)) {
        throw createHttpError('meeting_share_invalid');
      }
      const body = await readJson(req);
      const role = body?.role || 'viewer';
      const expiresAt = role === 'recorder' && body?.expiresAt === undefined
        ? Date.now() + 30 * 60 * 1000
        : body?.expiresAt ?? null;
      if (role === 'recorder' && !Number.isFinite(expiresAt)) throw createHttpError('invalid_request');
      const share = await sessionShareService.createShare(sessionId, { role, expiresAt });
      statusCode = 201;
      sendJson(res, statusCode, {
        share,
        url: `#watch?token=${encodeURIComponent(share.token)}`,
        codeUrl: `#watch?code=${encodeURIComponent(share.shortCode)}`,
        ...(share.role === 'recorder'
          ? {
              recorderUrl: `#record?token=${encodeURIComponent(share.token)}`,
              recorderCodeUrl: `#record?code=${encodeURIComponent(share.shortCode)}`
            }
          : {})
      }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'GET' && isSessionShareCollectionPath(path)) {
    try {
      const sessionId = decodeSessionPath(path, '/api/sessions/', '/shares');
      const existing = await sessionRepository.getSessionRecord(sessionId);
      if (!existing?.sessionRecord) throw createHttpError('session_not_found');
      statusCode = 200;
      sendJson(res, statusCode, { shares: await sessionShareService.listShares(sessionId) }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'DELETE' && isSessionSharePath(path)) {
    try {
      const { sessionId, shareId } = parseSessionSharePath(path);
      if (!await sessionShareService.revokeShare(sessionId, shareId)) throw createHttpError('session_not_found');
      statusCode = 200;
      sendJson(res, statusCode, { deleted: true, sessionId, shareId }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'GET' && isSharedSessionDetailPath(path)) {
    const token = decodeURIComponent(path.slice('/api/shared-sessions/'.length));
    const share = await sessionShareService.resolveShare(token);
    if (!share) {
      sendJson(res, 404, errorPayload('session_not_found', requestId), requestId);
      return;
    }
    const detail = await sessionReadController.getSession(share.sessionId);
    if (!detail) {
      sendJson(res, 404, errorPayload('session_not_found', requestId), requestId);
      return;
    }
    sendJson(res, 200, { ...publicViewerDetail(detail), capability: { role: share.role || 'viewer', sessionId: share.sessionId, expiresAt: share.expiresAt } }, requestId);
    return;
  }

  if (isRecorderLeasePath(req.method, path)) {
    try {
      if (!recorderLeaseService) throw createHttpError('recorder_lease_invalid');
      const share = await resolveRecorderShare(path, sessionShareService);
      if (!share || share.role !== 'recorder') throw createHttpError('recorder_forbidden');
      const body = req.method === 'POST' ? await readJson(req) : {};
      let lease;
      if (path.endsWith('/recorder-lease') && req.method === 'POST') {
        lease = await recorderLeaseService.claim(share.sessionId);
        const issued = recorderGrantService.issue({ sessionId: share.sessionId, shareId: share.id, leaseId: lease.leaseId, fenceToken: lease.fenceToken });
        const detail = await sessionReadController.getSession(share.sessionId);
        sendJson(res, 200, { session: publicViewerDetail(detail), capability: { role: 'recorder', sessionId: share.sessionId, expiresAt: share.expiresAt }, recorderGrant: issued.grant, grantExpiresAt: issued.expiresAt, lease }, requestId);
        return;
      } else if (path.endsWith('/heartbeat')) {
        lease = await recorderLeaseService.heartbeat(share.sessionId, body.leaseId, body.fenceToken);
        const refreshed = recorderGrantService.refresh(body.recorderGrant || req.headers?.['x-recorder-grant'], { leaseId: lease.leaseId, fenceToken: lease.fenceToken });
        if (!refreshed) throw createHttpError('recorder_grant_invalid');
        const detail = await sessionReadController.getSession(share.sessionId);
        sendJson(res, 200, { session: publicViewerDetail(detail), capability: { role: 'recorder', sessionId: share.sessionId, expiresAt: share.expiresAt }, grantExpiresAt: refreshed.expiresAt, lease }, requestId);
        return;
      } else {
        await recorderLeaseService.release(share.sessionId, body.leaseId, body.fenceToken);
        lease = null;
      }
      const detail = await sessionReadController.getSession(share.sessionId);
      sendJson(res, req.method === 'DELETE' ? 200 : 200, { session: publicViewerDetail(detail), capability: { role: 'recorder', sessionId: share.sessionId, expiresAt: share.expiresAt }, lease }, requestId);
    } catch (error) {
      const code = errorCodeFor(error); statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'GET' && isSharedSessionCodeDetailPath(path)) {
    const code = decodeURIComponent(path.slice('/api/shared-sessions/code/'.length));
    const share = await sessionShareService.resolveCode(code);
    if (!share) {
      sendJson(res, 404, errorPayload('session_not_found', requestId), requestId);
      return;
    }
    const detail = await sessionReadController.getSession(share.sessionId);
    if (!detail) {
      sendJson(res, 404, errorPayload('session_not_found', requestId), requestId);
      return;
    }
    sendJson(res, 200, publicViewerDetail(detail), requestId);
    return;
  }

  if (req.method === 'GET' && isSharedSessionEventsPath(path)) {
    const token = decodeURIComponent(path.slice('/api/shared-sessions/'.length, -'/events'.length));
    const share = await sessionShareService.resolveShare(token);
    if (!share) {
      sendJson(res, 404, errorPayload('session_not_found', requestId), requestId);
      return;
    }
    openSharedSessionEvents(res, req, share, sessionEventBroadcaster);
    return;
  }

  if (req.method === 'GET' && isSharedSessionCodeEventsPath(path)) {
    const code = decodeURIComponent(path.slice('/api/shared-sessions/code/'.length, -'/events'.length));
    const share = await sessionShareService.resolveCode(code);
    if (!share) {
      sendJson(res, 404, errorPayload('session_not_found', requestId), requestId);
      return;
    }
    return openSharedSessionEvents(res, req, share, sessionEventBroadcaster);
  }

  if (req.method === 'GET' && path === '/api/translation-providers') {
    try {
      const providers = translationProviderOptionsController
        ? await translationProviderOptionsController.listTranslationProviders()
        : safeTranslationProvidersFor();
      statusCode = 200;
      sendJson(res, statusCode, { providers }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  const exportController = createExportController({ exportArtifactService });
  if (exportController?.matches(path)) {
    if (authenticatedUser?.role !== 'super_admin' && currentRequestActorId() !== currentRequestOwnerId()) {
      statusCode = 403;
      sendJson(res, statusCode, errorPayload('auth_forbidden', requestId), requestId);
      return;
    }
    await exportController.handle({ req, res, path, requestId });
    return;
  }

  if (req.method === 'GET' && path === '/api/meetings') {
    try {
      if (!meetingReadController) throw createHttpError('meeting_read_unavailable');
      const meetings = await meetingReadController.listMeetings(authenticatedUser);
      statusCode = 200;
      sendJson(res, statusCode, meetings, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      meetingDiagnosticErrorCode = code;
      meetingDiagnosticSupabaseStatus = Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null;
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      requestLogger({ level: statusCode >= 500 ? 'error' : 'info', event: 'meeting_request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin, ...meetingRequestDiagnostics({ operation: `${req.method} ${path}`, meetingId: meetingDiagnosticId, authenticatedUser, statusCode, errorCode: meetingDiagnosticErrorCode, supabaseStatus: meetingDiagnosticSupabaseStatus }) });
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/meetings/glossary/import/preview') {
    try {
      if (!glossaryController?.previewPrivateImport) throw createHttpError('glossary_not_configured');
      const body = await readJson(req, { maxBytes: GLOSSARY_IMPORT_MAX_BYTES });
      if (!isPlainRequestObject(body) || !['csv', 'json', 'xlsx'].includes(body.format) || typeof body.content !== 'string' || typeof body.sourceLanguageCode !== 'string' || typeof body.targetLanguageCode !== 'string' || !Array.isArray(body.existingEntries)) throw createHttpError('invalid_request');
      validateSupportedTargetLanguageCode(body.sourceLanguageCode);
      validateSupportedTargetLanguageCode(body.targetLanguageCode);
      statusCode = 200;
      sendJson(res, statusCode, await glossaryController.previewPrivateImport(body), requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId, error.details), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'GET' && isMeetingDetailPath(path)) {
    try {
      if (!meetingReadController) throw createHttpError('meeting_read_unavailable');
      const { meetingId } = parseMeetingDetailPath(path);
      meetingDiagnosticId = meetingId;
      const meeting = await meetingReadController.getMeeting(meetingId, authenticatedUser);

      if (!meeting) {
        statusCode = 404;
        meetingDiagnosticErrorCode = 'meeting_not_found';
        sendJson(res, statusCode, errorPayload('meeting_not_found', requestId), requestId);
        return;
      }

      statusCode = 200;
      sendJson(res, statusCode, {
        ...meeting,
        meeting: {
          ...meeting.meeting,
          permissions: await meetingPermissionsFor(meetingId, authenticatedUser, meetingMembershipService)
        }
      }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      meetingDiagnosticErrorCode = code;
      meetingDiagnosticSupabaseStatus = Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null;
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      requestLogger({ level: statusCode >= 500 ? 'error' : 'info', event: 'meeting_request', requestId, method: req.method, path, durationMs: Math.round(performance.now() - startedAt), clientIp, origin, ...meetingRequestDiagnostics({ operation: `${req.method} ${path}`, meetingId: meetingDiagnosticId, authenticatedUser, statusCode, errorCode: meetingDiagnosticErrorCode, supabaseStatus: meetingDiagnosticSupabaseStatus }) });
    }
    return;
  }

  if (((req.method === 'GET' || req.method === 'POST') && isMeetingShareCollectionPath(path)) ||
      (req.method === 'DELETE' && isMeetingSharePath(path))) {
    try {
      const meetingId = req.method === 'DELETE'
        ? parseMeetingSharePath(path).meetingId
        : parseMeetingShareCollectionPath(path);
      if (!sessionShareService) throw createHttpError('meeting_share_invalid');
      if (req.method === 'GET') {
        statusCode = 200;
        const shares = typeof sessionShareService.listMeetingShares === 'function'
          ? await sessionShareService.listMeetingShares(meetingId)
          : await sessionShareService.listShares(meetingId);
        sendJson(res, statusCode, { shares: shares.map((share) => ({
          ...share,
          ...(share.shortCode ? { codeUrl: `#${share.role === 'viewer' ? 'viewer' : 'record'}?code=${encodeURIComponent(share.shortCode)}` } : {})
        })) }, requestId);
      } else if (req.method === 'POST') {
        await assertMeetingShareMutable(meetingId, meetingRepository);
        const body = await readJson(req);
        const role = body?.role || 'recorder';
        if (role !== 'viewer' && role !== 'recorder') throw createHttpError('invalid_request');
        const share = body?.ensureExisting === true && typeof sessionShareService.ensureMeetingShare === 'function'
          ? await sessionShareService.ensureMeetingShare(meetingId, { role, expiresAt: body?.expiresAt ?? null })
          : await sessionShareService.createMeetingShare(meetingId, { role, expiresAt: body?.expiresAt ?? null });
        statusCode = 201;
        const payload = {
          share,
          ...(share.token ? { url: `#${role === 'viewer' ? 'viewer' : 'record'}?token=${encodeURIComponent(share.token)}` } : {}),
          ...(share.shortCode ? { codeUrl: `#${role === 'viewer' ? 'viewer' : 'record'}?code=${encodeURIComponent(share.shortCode)}` } : {})
        };
        sendJson(res, statusCode, payload, requestId);
      } else {
        const shareId = parseMeetingSharePath(path).shareId;
        await assertMeetingShareRevocable(meetingId, shareId, meetingRepository, sessionShareService);
        if (!await sessionShareService.revokeShare(meetingId, shareId)) throw createHttpError('meeting_share_invalid');
        statusCode = 204;
        res.writeHead(statusCode, { 'X-Request-Id': requestId });
        res.end();
      }
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'DELETE' && isMeetingDetailPath(path)) {
    try {
      if (!meetingDeletionService) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId } = parseMeetingDetailPath(path);
      const result = await meetingDeletionService.deleteMeeting({ meetingId, actorUserId: authenticatedUser?.id, actorRole: authenticatedUser?.role });
        if (result.deleting) {
          statusCode = 202;
          sendJson(res, statusCode, { status: 'deleting' }, requestId);
          return;
        }
      statusCode = 204;
      res.writeHead(statusCode, { 'X-Request-Id': requestId });
      res.end();
      return;
    } catch (error) {
      const code = errorCodeFor(error);
      meetingDiagnosticErrorCode = code;
      meetingDiagnosticSupabaseStatus = Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null;
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
      const authorizationDiagnostics = await collectMeetingAuthorizationDiagnostics({
        meetingId: meetingDiagnosticId,
        authenticatedUser,
        profileService,
        meetingMembershipService
      });
      requestLogger({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'meeting_request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin,
        authStage: 'private_resource',
        ...meetingRequestDiagnostics({
          operation: `${req.method} ${path}`,
          meetingId: meetingDiagnosticId,
          authenticatedUser,
          statusCode,
          errorCode: code,
          supabaseStatus: meetingDiagnosticSupabaseStatus,
          resourceOwnerId: authorizationDiagnostics.resourceOwnerId,
          resourceOwnerKnown: true
        }),
        ...authorizationDiagnostics
      });
    }
    return;
  }

  if (req.method === 'POST' && (isMeetingRecordingCommandPath(path) || isMeetingLifecycleHeartbeatPath(path))) {
    try {
      if (!meetingLifecycleService) throw createHttpError('cloud_capability_unavailable');
      const route = parseMeetingLifecyclePath(path);
      const body = await readJson(req, { maxBytes: meetingCheckpointMaxBytes });
      const principal = await resolveMeetingLifecyclePrincipal({
        req,
        meetingId: route.meetingId,
        authenticatedUser,
        meetingMembershipService,
        sessionShareService
      });

      if (route.action === 'lease-heartbeat') {
        statusCode = 200;
        sendJson(res, statusCode, await meetingLifecycleService.renewLease({
          ...principal,
          meetingId: route.meetingId,
          leaseId: body?.leaseId,
          fenceToken: body?.fenceToken
        }), requestId);
        return;
      }

      if (route.action === 'liveness') {
        statusCode = 200;
        sendJson(res, statusCode, await meetingLifecycleService.touchLiveness({
          ...principal,
          meetingId: route.meetingId,
          leaseId: body?.leaseId,
          fenceToken: body?.fenceToken
        }), requestId);
        return;
      }

      const payload = { ...(body || {}) };
      for (const field of ['operationId', 'expectedLifecycleVersion', 'leaseId', 'fenceToken']) delete payload[field];
      const result = await meetingLifecycleService.execute({
        ...principal,
        meetingId: route.meetingId,
        command: route.action,
        operationId: body?.operationId,
        expectedLifecycleVersion: body?.expectedLifecycleVersion,
        leaseId: body?.leaseId,
        fenceToken: body?.fenceToken,
        payload
      });
      statusCode = ['start', 'resume', 'rollover', 'recover', 'takeover'].includes(route.action) ? 201 : 200;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (meetingLifecycleService && isMeetingLifecycleFencedWrite(req.method, path)) {
    try {
      const target = parseMeetingLifecycleFencedWritePath(path);
      const fenceValue = req.headers?.['x-meeting-fence-token'];
      await meetingLifecycleService.validateWrite({
        meetingId: target.meetingId,
        sessionId: req.headers?.['x-meeting-session-id'],
        segmentId: target.segmentId || req.headers?.['x-meeting-segment-id'],
        leaseId: req.headers?.['x-meeting-lease-id'],
        fenceToken: fenceValue === undefined ? null : Number(fenceValue)
      });
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
      return;
    }
  }

  if (req.method === 'POST' && isMeetingCompletePath(path)) {
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId } = parseMeetingCompletePath(path);
      const result = await meetingCheckpointService.completeMeeting({ meetingId });
      statusCode = 200;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'PATCH' && isMeetingDetailPath(path)) {
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const meetingId = parseMeetingDetailPath(path).meetingId;
      meetingDiagnosticId = meetingId;
      const body = await readJson(req, { maxBytes: meetingCheckpointMaxBytes });
      if (body?.targetLanguageCode && !isSupportedLanguage(body.targetLanguageCode)) throw createHttpError('unsupported_language');
      if (body?.sourceLanguageCode && !isSupportedLanguage(body.sourceLanguageCode)) throw createHttpError('unsupported_language');
      const result = await meetingCheckpointService.updateMeeting({ meetingId, settings: {
        ...(Object.hasOwn(body || {}, 'name') ? { name: body.name } : {}),
        ...(Object.hasOwn(body || {}, 'sourceLanguageCode') ? { sourceLanguageCode: body.sourceLanguageCode } : {}),
        ...(Object.hasOwn(body || {}, 'targetLanguageCode') ? { targetLanguageCode: body.targetLanguageCode } : {}),
        ...(Object.hasOwn(body || {}, 'echoTargetLanguage') ? { echoTargetLanguage: body.echoTargetLanguage !== false } : {}),
        ...(Object.hasOwn(body || {}, 'shouldRecordInputAudio') ? { shouldRecordInputAudio: body.shouldRecordInputAudio === true } : {}),
        ...(Object.hasOwn(body || {}, 'glossaryEntries') ? { glossaryEntries: body.glossaryEntries } : {}),
        ...(Object.hasOwn(body || {}, 'privateGlossaryEntries') ? { privateGlossaryEntries: body.privateGlossaryEntries } : {})
      }});
      statusCode = 200;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      meetingDiagnosticErrorCode = code;
      meetingDiagnosticSupabaseStatus = Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null;
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      requestLogger({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'meeting_request',
        operation: `${req.method} ${path}`,
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin,
        ...meetingRequestDiagnostics({
          operation: `${req.method} ${path}`,
          meetingId: meetingDiagnosticId,
          authenticatedUser,
          statusCode,
          errorCode: meetingDiagnosticErrorCode,
          supabaseStatus: meetingDiagnosticSupabaseStatus
        })
      });
    }
    return;
  }

  if (req.method === 'POST' && isMeetingAudioUploadStartPath(path)) {
    try {
      if (!meetingAudioService) throw createHttpError('cloud_capability_unavailable');
      const { meetingId, segmentId } = parseMeetingAudioUploadStartPath(path);
      const body = await readJson(req, { maxBytes: DEFAULT_JSON_REQUEST_MAX_BYTES });
      statusCode = 201;
      sendJson(res, statusCode, await meetingAudioService.beginUpload({
        meetingId,
        segmentId,
        mimeType: body?.mimeType,
        byteSize: body?.byteSize
      }), requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'POST' && isMeetingAudioArtifactActionPath(path)) {
    try {
      if (!meetingAudioService) throw createHttpError('cloud_capability_unavailable');
      const { meetingId, artifactId, action } = parseMeetingAudioArtifactActionPath(path);
      if (action === 'download-url' && authenticatedUser?.role !== 'super_admin' && currentRequestActorId() !== currentRequestOwnerId()) {
        throw createHttpError('auth_forbidden');
      }
      let result;
      if (action === 'complete') result = await meetingAudioService.completeUpload({ meetingId, artifactId });
      else if (action === 'fail') result = await meetingAudioService.failUpload({ meetingId, artifactId });
      else if (action === 'retry') result = await meetingAudioService.retryArtifact({ meetingId, artifactId });
      else {
        result = await meetingAudioService.createDownloadUrl({ meetingId, artifactId, expiresIn: 60 });
        res.setHeader?.('Cache-Control', 'no-store');
      }
      statusCode = 200;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'GET' && isMeetingAudioPath(path)) {
    try {
      const { meetingId, kind } = parseMeetingAudioPath(path);
      const artifacts = await listMeetingAudioArtifacts({ sessionRepository, meetingRepository, meetingId, kind });
      if (artifacts.length === 0) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }

      statusCode = 200;
      const parts = await Promise.all(artifacts.map((metadata) => sessionAudioArtifactRepository.read(metadata)));
      const bytes = composeWavSegments(parts.map((part) => part.bytes));
      sendBinary(res, statusCode, bytes, {
        contentType: 'audio/wav',
        fileName: `live-translate-meeting-${meetingId}-${kind}.wav`,
        requestId
      });
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/meetings') {
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const input = await readJson(req, { maxBytes: meetingCheckpointMaxBytes });
      if (input?.targetLanguageCode && !isSupportedLanguage(input.targetLanguageCode)) throw createHttpError('unsupported_language');
      if (input?.sourceLanguageCode && !isSupportedLanguage(input.sourceLanguageCode)) throw createHttpError('unsupported_language');
      const result = await meetingCheckpointService.createMeeting({ ...input, draft: input?.draft === true });
      meetingDiagnosticId = result?.meeting?.id || null;
      statusCode = 201;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      meetingDiagnosticErrorCode = code;
      meetingDiagnosticSupabaseStatus = Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null;
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      requestLogger({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'meeting_request',
        operation: `${req.method} ${path}`,
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin,
        ...meetingRequestDiagnostics({
          operation: `${req.method} ${path}`,
          meetingId: meetingDiagnosticId,
          authenticatedUser,
          statusCode,
          errorCode: meetingDiagnosticErrorCode,
          supabaseStatus: meetingDiagnosticSupabaseStatus
        })
      });
    }
    return;
  }

  if (req.method === 'GET' && isSharedMeetingDetailPath(path)) {
    const share = await resolveSharedMeeting(path, sessionShareService);
    if (!share || share.resourceType !== 'meeting' || !['viewer', 'recorder'].includes(share.role)) {
      sendJson(res, 404, errorPayload('meeting_share_invalid', requestId), requestId);
      return;
    }
    if (share._ownerUserId) setRequestUser({ id: share._ownerUserId });
    const meeting = share.role === 'viewer'
      ? await meetingReadController?.getMeetingViewerPage(share.meetingId, parseViewerPageOptions(req))
      : await meetingReadController?.getMeeting(share.meetingId);
    if (!meeting) {
      sendJson(res, 404, errorPayload('meeting_not_found', requestId), requestId);
      return;
    }
    const payload = share.role === 'viewer' ? publicMeetingViewerDetail(meeting) : meeting;
    if (share.role === 'viewer') {
      const cursor = meetingEventRepository
        ? await meetingEventRepository.latestCursor(share.meetingId, { ownerUserId: share._ownerUserId })
        : meetingEventBroadcaster?.cursor(share.meetingId) || { eventId: 0, cueSequence: 0 };
      payload.cursor = {
        eventId: cursor.eventId,
        cueSequence: Math.max(cursor.cueSequence, ...((payload.cues || []).map((cue) => Number(cue.sequence) || 0)))
      };
    }
    sendJson(res, 200, { ...payload, capability: { role: share.role, meetingId: share.meetingId, expiresAt: share.expiresAt } }, requestId);
    return;
  }

  if (req.method === 'POST' && isMeetingCuePublishPath(path)) {
    const cueRequestContext = {};
    try {
      if ((!meetingEventBroadcaster && !meetingCueService) || !sessionRepository) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId, segmentId } = parseMeetingCuePublishPath(path);
      cueRequestContext.meetingId = meetingId;
      cueRequestContext.segmentId = segmentId;
      const body = await readJson(req, { maxBytes: 100_000 });
      const sessionId = body?.sessionId || req.headers?.['x-recorder-session-id'];
      cueRequestContext.sessionId = sessionId || null;
      const existing = await sessionRepository.getSessionRecord(sessionId);
      if (!existing?.sessionRecord || existing.sessionRecord.meetingId !== meetingId || existing.sessionRecord.segmentId !== segmentId) {
        throw createHttpError('recorder_session_mismatch');
      }
      if (hasRecorderHeaders(req)) {
        await authorizeRecorderMeetingWrite({
          req,
          meetingId,
          segmentId,
          sessionRepository,
          sessionShareService,
          recorderGrantService,
          recorderLeaseService
        });
      }
      const cue = normalizePublishedCue(body?.cue, { meetingId, segmentId, sessionId });
      cueRequestContext.cueId = cue.cueId;
      cueRequestContext.sequence = cue.sequence;
      if (meetingCueService) {
        await meetingCueService.persist({ meetingId, segmentId, sessionId, sessionRecord: existing.sessionRecord, cue });
        const event = meetingEventRepository
          ? await meetingEventRepository.append({ meetingId, segmentId, cue })
          : null;
        statusCode = 202;
        sendJson(res, statusCode, { transport: 'supabase', eventId: event?.eventId || null, cueSequence: cue.sequence }, requestId);
        return;
      }
      const event = meetingEventBroadcaster.publish(meetingId, { segmentId, cue, producedAt: body?.producedAt });
      statusCode = 202;
      sendJson(res, statusCode, { eventId: event.eventId, cueSequence: event.cue.sequence }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      requestLogger({
        level: statusCode >= 500 ? 'error' : 'warn',
        event: 'meeting_cue_publish_failed',
        requestId,
        method: req.method,
        path,
        statusCode,
        errorCode: code,
        ...safeSupabaseFailureDiagnostics(error),
        ...cueRequestContext,
        durationMs: Math.round(performance.now() - startedAt)
      });
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'POST' && isSharedMeetingRealtimeTokenPath(path)) {
    try {
      if (!viewerRealtimeTokenService) throw createHttpError('cloud_capability_unavailable');
      enforceRateLimit(clientIp);
      const share = await resolveSharedMeeting(path, sessionShareService);
      if (!share || share.resourceType !== 'meeting' || share.role !== 'viewer') throw createHttpError('meeting_share_invalid');
      if (share._ownerUserId) setRequestUser({ id: share._ownerUserId });
      if (isMeetingContentExpired(await meetingRepository?.getMeeting(share.meetingId))) throw meetingContentExpiredError();
      statusCode = 200;
      res.setHeader?.('Cache-Control', 'no-store');
      sendJson(res, statusCode, await viewerRealtimeTokenService.issue(share), requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'GET' && isSharedMeetingEventsPath(path)) {
    const share = await resolveSharedMeeting(path, sessionShareService);
    if (!share || share.resourceType !== 'meeting' || share.role !== 'viewer') {
      sendJson(res, 404, errorPayload('meeting_share_invalid', requestId), requestId);
      return;
    }
    if (share._ownerUserId) setRequestUser({ id: share._ownerUserId });
    if (isMeetingContentExpired(await meetingRepository?.getMeeting(share.meetingId))) {
      sendJson(res, 410, errorPayload('meeting_content_expired', requestId), requestId);
      return;
    }
    const wantsJsonReplay = req.headers?.accept?.includes('application/json');
    if (meetingEventRepository && (viewerRealtimeTokenService || wantsJsonReplay)) {
      const replay = await meetingEventRepository.listSince(share.meetingId, parseAfterEventId(req), { ownerUserId: share._ownerUserId });
      const cursor = await meetingEventRepository.latestCursor(share.meetingId, { ownerUserId: share._ownerUserId });
      sendJson(res, 200, { events: replay.map(publicMeetingCueEvent), cursor }, requestId);
    } else if (wantsJsonReplay && meetingEventBroadcaster) {
      const replay = meetingEventBroadcaster.eventsSince(share.meetingId, parseAfterEventId(req));
      sendJson(res, 200, {
        events: replay.events.map(publicMeetingCueEvent),
        cursor: replay.cursor,
        gap: replay.gap
      }, requestId);
    } else if (meetingEventBroadcaster) {
      openSharedMeetingEvents(res, req, share, meetingEventBroadcaster, meetingReadController, parseAfterEventId(req));
    } else {
      sendJson(res, 410, errorPayload('realtime_required', requestId), requestId);
    }
    return;
  }

  if (req.method === 'POST' && isSharedMeetingStartPath(path)) {
    try {
      if (!meetingCheckpointService || !sessionRepository) throw createHttpError('meeting_checkpoint_unavailable');
      const share = await resolveSharedMeeting(path, sessionShareService);
      if (!share || share.resourceType !== 'meeting' || share.role !== 'recorder') throw createHttpError('meeting_share_invalid');
      const meeting = await meetingRepository.getMeeting(share.meetingId);
      const segments = await meetingCheckpointService.listMeetingSegments(share.meetingId);
      const segment = [...segments].reverse().find((item) => (item.status === 'active' || item.status === 'created') && !item.liveSessionId);
      if (!meeting || !segment) throw createHttpError('meeting_share_invalid');
      const body = await readJson(req);
      const liveSessionId = body?.liveSessionId || `live-session-${crypto.randomUUID()}`;
      const started = segment.status === 'created'
        ? await meetingCheckpointService.startMeeting({ meetingId: share.meetingId, segmentId: segment.id, liveSessionId })
        : await meetingCheckpointService.attachLiveSession({ meetingId: share.meetingId, segmentId: segment.id, liveSessionId });
      const session = await sessionRepository.createSessionRecord({
        id: body?.sessionId,
        name: meeting.name || `會議 ${new Date().toLocaleString('zh-TW')}`,
        targetLanguageCode: meeting.targetLanguageCode || 'en',
        targetLanguageLabel: meeting.targetLanguageCode || null,
        sourceLanguageCode: meeting.sourceLanguageCode || null,
        echoTargetLanguage: meeting.echoTargetLanguage !== false,
        shouldRecordInputAudio: meeting.shouldRecordInputAudio === true,
        meetingGlossaryEntries: [
          ...(meeting.glossaryEntries || []),
          ...((meeting.privateGlossaryEntries || []).map((entry) => ({
            source: entry.source,
            target: entry.translations?.[meeting.targetLanguageCode],
            replacementAliases: entry.replacementAliases?.[meeting.targetLanguageCode] || []
          })).filter((entry) => entry.target))
        ],
        meetingId: share.meetingId,
        segmentId: started.segment.id,
        status: 'created',
        startedAt: null
      });
      if (!await sessionShareService.bindShareToSession(share.id, session.id)) throw createHttpError('meeting_share_invalid');
      const detail = await sessionReadController.getSession(session.id);
      statusCode = 201;
      sendJson(res, statusCode, { session: detail?.session || session, meetingId: share.meetingId, segmentId: started.segment.id, liveSessionId }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'POST' && isMeetingSegmentRolloverPath(path)) {
    let meetingCheckpointError = null;
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId, segmentId } = parseMeetingSegmentRolloverPath(path);
      await authorizeRecorderMeetingWrite({ req, meetingId, segmentId, sessionRepository, sessionShareService, recorderGrantService, recorderLeaseService });
      const result = await meetingCheckpointService.rolloverSegment({
        meetingId,
        segmentId,
        rollover: await readJson(req, { maxBytes: meetingCheckpointMaxBytes })
      });
      statusCode = 201;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      meetingCheckpointError = error;
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'request',
        requestId,
        method: req.method,
        path,
        statusCode,
        errorCode: meetingCheckpointError?.code || null,
        ...safeSupabaseFailureDiagnostics(meetingCheckpointError),
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin
      });
    }
    return;
  }

  if (req.method === 'POST' && isMeetingSegmentStartPath(path)) {
    let meetingCheckpointError = null;
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId, segmentId } = parseMeetingSegmentStartPath(path);
      const body = await readJson(req, { maxBytes: meetingCheckpointMaxBytes });
      const result = await meetingCheckpointService.startMeeting({ meetingId, segmentId, liveSessionId: body?.liveSessionId });
      statusCode = 201;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      meetingCheckpointError = error;
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      const errorCode = meetingCheckpointError ? errorCodeFor(meetingCheckpointError) : null;
      logEvent({
        level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
        event: 'meeting_segment_start',
        requestId,
        method: req.method,
        path,
        statusCode,
        errorCode,
        errorMessage: meetingCheckpointError ? (ERROR_RESPONSES[errorCode]?.message || 'Meeting segment start failed.') : null,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin
      });
    }
    return;
  }

  if (req.method === 'POST' && isMeetingSegmentRecoverPath(path)) {
    let meetingCheckpointError = null;
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId, segmentId } = parseMeetingSegmentRecoverPath(path);
      await authorizeRecorderMeetingWrite({ req, meetingId, segmentId, sessionRepository, sessionShareService, recorderGrantService, recorderLeaseService });
      const result = await meetingCheckpointService.recoverSegment({
        meetingId,
        segmentId,
        recovery: await readJson(req, { maxBytes: meetingCheckpointMaxBytes })
      });
      statusCode = 201;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      meetingCheckpointError = error;
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, errorCode: meetingCheckpointError?.code || null, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'GET' && isMeetingSegmentsPath(path)) {
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      const { meetingId } = parseMeetingSegmentsPath(path);
      const segments = await meetingCheckpointService.listMeetingSegments(meetingId);
      statusCode = 200;
      sendJson(res, statusCode, { meetingId, segments }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if ((req.method === 'GET' || req.method === 'PUT') && isMeetingSegmentCheckpointPath(path)) {
    let meetingCheckpointError = null;
    let checkpointParams = null;
    try {
      if (!meetingCheckpointService) throw createHttpError('meeting_checkpoint_unavailable');
      checkpointParams = parseMeetingSegmentCheckpointPath(path, { strictIds: strictCheckpointPathIds });
      const { meetingId, segmentId } = checkpointParams;
      if (req.method === 'PUT') {
        await authorizeRecorderMeetingWrite({ req, meetingId, segmentId, sessionRepository, sessionShareService, recorderGrantService, recorderLeaseService });
      }
      const result = req.method === 'GET'
        ? await meetingCheckpointService.getCheckpoint({ meetingId, segmentId })
        : await meetingCheckpointService.updateCheckpoint({
            meetingId,
            segmentId,
            checkpoint: await readJson(req, { maxBytes: meetingCheckpointMaxBytes })
          });
      statusCode = 200;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      meetingCheckpointError = error;
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId, error.details), requestId);
    } finally {
      const checkpointErrorCode = meetingCheckpointError ? errorCodeFor(meetingCheckpointError) : null;
      if (meetingCheckpointError && statusCode >= 400 && statusCode < 500 && ['invalid_request', 'subtitle_cue_invalid'].includes(checkpointErrorCode)) {
        const query = new URL(req.url || '/', 'http://localhost').search;
        if (!checkpointParams && checkpointErrorCode === 'invalid_request') {
          try {
            checkpointParams = parseMeetingSegmentCheckpointPath(path, { strictIds: false });
          } catch {
            checkpointParams = null;
          }
        }
        logEvent({
          level: 'warn',
          event: 'checkpoint-validation-failed',
          requestId,
          method: req.method,
          path,
          params: checkpointParams,
          query,
          bodyPresence: Number(req.headers?.['content-length'] || 0) > 0,
          validationIssues: meetingCheckpointError.details || [meetingCheckpointError.message]
        });
      }
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, errorCode: meetingCheckpointError?.code || null, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'DELETE' && isSessionTranslationOutputPath(path)) {
    try {
      if (!translationRepository) throw createHttpError('saved_transcript_retranslation_unavailable');
      const { sessionId, outputId } = parseSessionTranslationOutputPath(path);
      const output = await translationRepository.getTranslationOutput(outputId);

      if (!isDeletableRetranslationOutput(output, sessionId)) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('translation_output_not_found', requestId), requestId);
        return;
      }

      const deleted = await translationRepository.deleteTranslationOutput(outputId);

      if (!deleted) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('translation_output_not_found', requestId), requestId);
        return;
      }

      statusCode = 200;
      sendJson(res, statusCode, { deleted: true, sessionId, outputId }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'POST' && isSessionAudioPath(path)) {
    try {
      const { sessionId, kind } = parseSessionAudioPath(path);
      await authorizeRecorderWrite({ req, sessionId, sessionShareService, recorderGrantService, recorderLeaseService });
      if (req.headers?.['content-type']?.split(';')[0] !== 'audio/wav') throw createHttpError('invalid_request');
      const existing = await sessionRepository.getSessionRecord(sessionId);
      if (!existing?.sessionRecord) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }
      const bytes = await readBinary(req, { maxBytes: sessionAudioMaxBytes });
      if (bytes.byteLength === 0) throw createHttpError('invalid_request');
      const metadata = await sessionAudioArtifactRepository.save({
        sessionId,
        kind,
        bytes,
        fileName: String(req.headers?.['x-file-name'] || '')
      });
      const audioArtifacts = {
        ...(existing.sessionRecord.audioArtifacts || {}),
        [kind]: metadata
      };
      const updated = await sessionRepository.updateSessionRecord(sessionId, { audioArtifacts });
      statusCode = 201;
      sendJson(res, statusCode, {
        artifact: sanitizeAudioArtifactsForDTO(updated.audioArtifacts, { sessionId })[kind]
      }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'POST' && isSessionAudioSegmentPath(path)) {
    try {
      const { sessionId, kind, segmentIndex } = parseSessionAudioSegmentPath(path);
      await authorizeRecorderWrite({ req, sessionId, sessionShareService, recorderGrantService, recorderLeaseService });
      if (req.headers?.['content-type']?.split(';')[0] !== 'audio/wav') throw createHttpError('invalid_request');
      const existing = await sessionRepository.getSessionRecord(sessionId);
      if (!existing?.sessionRecord) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }
      const bytes = await readBinary(req, { maxBytes: sessionAudioMaxBytes });
      if (bytes.byteLength === 0) throw createHttpError('invalid_request');
      const segment = await sessionAudioArtifactRepository.saveSegment({
        sessionId,
        kind,
        segmentIndex,
        bytes
      });
      const currentArtifact = existing.sessionRecord.audioArtifacts?.[kind];
      const fileName = String(req.headers?.['x-file-name'] || currentArtifact?.fileName || `${kind}.wav`);
      const segments = [
        ...((currentArtifact?.storageMode === 'segmented' && Array.isArray(currentArtifact.segments))
          ? currentArtifact.segments.filter((item) => item.index !== segment.index)
          : []),
        segment
      ].sort((left, right) => left.index - right.index);
      const artifact = {
        kind,
        storageMode: 'segmented',
        mimeType: 'audio/wav',
        byteLength: segments.reduce((total, item) => total + item.byteLength, 0),
        fileName,
        segments,
        createdAt: currentArtifact?.createdAt ?? segment.createdAt,
        updatedAt: segment.createdAt
      };
      const audioArtifacts = {
        ...(existing.sessionRecord.audioArtifacts || {}),
        [kind]: artifact
      };
      const updated = await sessionRepository.updateSessionRecord(sessionId, { audioArtifacts });
      statusCode = 201;
      sendJson(res, statusCode, {
        artifact: sanitizeAudioArtifactsForDTO(updated.audioArtifacts, { sessionId })[kind]
      }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'GET' && isSessionAudioPath(path)) {
    try {
      const { sessionId, kind } = parseSessionAudioPath(path);
      if (hasRecorderHeaders(req)) throw createHttpError('recorder_forbidden');
      const detail = await sessionRepository.getSessionRecord(sessionId);
      const metadata = detail?.sessionRecord?.audioArtifacts?.[kind];
      if (!metadata) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }
      statusCode = 200;
      if (metadata.storageMode === 'segmented' && typeof sessionAudioArtifactRepository.stream === 'function') {
        await sendBinaryStream(res, statusCode, sessionAudioArtifactRepository.stream(metadata), {
          contentType: 'audio/wav',
          contentLength: audioArtifactDownloadByteLength(metadata),
          fileName: metadata.fileName,
          requestId
        });
      } else {
        const artifact = await sessionAudioArtifactRepository.read(metadata);
        sendBinary(res, statusCode, artifact.bytes, {
          contentType: artifact.metadata.mimeType,
          fileName: artifact.metadata.fileName,
          requestId
        });
      }
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'DELETE' && path.startsWith('/api/sessions/') && path.length > '/api/sessions/'.length) {
    try {
      let sessionId;
      try {
        sessionId = decodeURIComponent(path.slice('/api/sessions/'.length));
      } catch {
        throw createHttpError('invalid_request');
      }
      if (!sessionId.trim()) throw createHttpError('invalid_request');
      const existing = await sessionRepository.getSessionRecord(sessionId);

      if (!existing?.sessionRecord || !DELETABLE_SESSION_STATUSES.has(existing.sessionRecord.status)) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }

      if (existing.sessionRecord.meetingId && meetingDeletionService) {
        const result = await meetingDeletionService.deleteMeeting({ meetingId: existing.sessionRecord.meetingId });
        statusCode = 200;
        sendJson(res, statusCode, {
          deleted: true,
          sessionId,
          meetingId: existing.sessionRecord.meetingId,
          deletedSessionCount: result.deletedSessionCount,
          deletedSegmentCount: result.deletedSegmentCount
        }, requestId);
        return;
      }

      await sessionAudioArtifactRepository?.deleteMany?.(existing.sessionRecord.audioArtifacts);
      const deleted = await sessionRepository.deleteSessionRecord(sessionId);

      if (!deleted) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }

      statusCode = 200;
      sendJson(res, statusCode, { deleted: true, sessionId }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (isGlossaryRoute(req.method, path)) {
    try {
      if (!glossaryController) throw createHttpError('glossary_not_configured');
      const { status, result } = await handleGlossaryCommand(req.method, path, req, glossaryController);
      statusCode = status;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId, error.details), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'PUT' && path.startsWith('/api/sessions/') && path.length > '/api/sessions/'.length) {
    try {
      const sessionId = decodeURIComponent(path.slice('/api/sessions/'.length));
      await authorizeRecorderWrite({ req, sessionId, sessionShareService, recorderGrantService, recorderLeaseService });
      const body = await readJson(req, { maxBytes: sessionSnapshotMaxBytes });
      if (body?.session?.id !== sessionId) throw createHttpError('invalid_request');
      if (hasRecorderHeaders(req)) {
        const existing = await sessionRepository.getSessionRecord(sessionId);
        validateRecorderSnapshot(existing?.sessionRecord, body);
      }
      const result = await createSessionSnapshotSyncService({
        sessionRepository
      }).sync(body);
      const detail = await sessionRepository.getSessionRecord(sessionId);
      if (detail) sessionEventBroadcaster.publish(sessionId, detail);
      statusCode = 200;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (req.method === 'PATCH' && path.startsWith('/api/sessions/') && path.length > '/api/sessions/'.length) {
    try {
      const sessionId = decodeURIComponent(path.slice('/api/sessions/'.length));
      const existing = await sessionRepository.getSessionRecord(sessionId);
      if (!existing?.sessionRecord) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }
      const body = await readJson(req);
      const allowedKeys = new Set(['name', 'status', 'targetLanguageCode', 'targetLanguageLabel', 'sourceLanguageCode', 'meetingId', 'segmentId']);
      const patch = Object.fromEntries(Object.entries(body || {}).filter(([key]) => allowedKeys.has(key)));
      if (patch.meetingId !== undefined && (typeof patch.meetingId !== 'string' || patch.meetingId.trim() === '')) {
        throw createHttpError('invalid_request');
      }
      if (patch.segmentId !== undefined && (typeof patch.segmentId !== 'string' || patch.segmentId.trim() === '')) {
        throw createHttpError('invalid_request');
      }
      if (patch.targetLanguageCode && !isSupportedLanguage(patch.targetLanguageCode)) {
        throw createHttpError('unsupported_language');
      }
      const session = sessionApplicationService
        ? await sessionApplicationService.updateSession(sessionId, patch)
        : await sessionRepository.updateSessionRecord(sessionId, patch);
      statusCode = 200;
      sendJson(res, statusCode, { session }, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'GET' && isSessionTranslationHistoryPath(path)) {
    let translationErrorCode = null;
    let translationSupabaseStatus = null;
    try {
      const { sessionId, targetLanguageCode } = parseSessionTranslationHistoryPath(req.url || path);
      if (targetLanguageCode !== undefined && !isSupportedLanguage(targetLanguageCode)) throw createHttpError('unsupported_language');
      const result = await translationHistoryController.listSessionTranslations({ sessionId, targetLanguageCode, includeReadModel: true });
      if (!result) { statusCode = 404; sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId); return; }
      statusCode = 200; sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      translationErrorCode = code;
      translationSupabaseStatus = Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null;
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      requestLogger({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin,
        errorCode: translationErrorCode,
        supabaseStatus: translationSupabaseStatus
      });
    }
    return;
  }

  if (req.method === 'POST' && isSessionRetranslationPath(path)) {
    try {
      if (!sessionRetranslationCommandController) throw createHttpError('saved_transcript_retranslation_unavailable');
      const body = await readJson(req);
      const result = await sessionRetranslationCommandController.submitRetranslation(
        validateSessionRetranslationRequest({ sessionId: extractSessionRetranslationSessionId(path), body })
      );
      translationExecutionWorkerRuntime?.wake?.();
      statusCode = 202;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    }
    return;
  }

  if (req.method === 'GET' && path.startsWith('/api/sessions/') && path.length > '/api/sessions/'.length) {
    let sessionReadErrorCode = null;
    let sessionReadSupabaseStatus = null;
    try {
      const sessionId = path.slice('/api/sessions/'.length);
      const session = sessionApplicationService
        ? await sessionApplicationService.getSessionDetail(sessionId)
        : await sessionReadController.getSession(sessionId);

      if (!session) {
        statusCode = 404;
        sendJson(res, statusCode, errorPayload('session_not_found', requestId), requestId);
        return;
      }

      if (translationHistoryController) {
        try {
          const history = await translationHistoryController.listSessionTranslations({ sessionId, includeReadModel: true });
          const formalHistory = history?.translationHistory;
          const historyOutputs = Array.isArray(formalHistory?.outputs) ? formalHistory.outputs : [];
          const primaryOutputs = historyOutputs.filter(isLiveSessionTranslationOutput);
          session.translationHistory = {
            outputs: [
              ...legacyTranslationFallback(session.translationOutputs),
              ...historyOutputs.filter((output) => output?.operation === 'transcript_polishing')
            ],
            executions: formalHistory?.executions || []
          };
          applyFormalOutputReadModel(session, primaryOutputs);
        } catch {
          // Translation history is an isolated read enhancement; preserve detail.
        }
      }

      statusCode = 200;
      sendJson(res, statusCode, session, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      sessionReadErrorCode = code;
      sessionReadSupabaseStatus = Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null;
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      requestLogger({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin,
        errorCode: sessionReadErrorCode,
        supabaseStatus: sessionReadSupabaseStatus
      });
    }
    return;
  }

  if (isTranslationCommandRoute(req.method, path)) {
    let translationErrorCode = null;
    let translationSupabaseStatus = null;
    try {
      assertTranslationCommandController(translationCommandController);

      const body = await readJson(req, {
        maxBytes: path === '/api/translation-outputs'
          ? translationOutputMaxBytes
          : DEFAULT_JSON_REQUEST_MAX_BYTES
      });
      const scope = await authorizeTranslationResource({
        req,
        path,
        body,
        user: authenticatedUser,
        meetingMembershipService,
        translationRepository,
        meetingRepository
      });
      if (scope) {
        setRequestUser({ ...authenticatedUser, ...scope, actorUserId: authenticatedUser.id });
        updateRequestScope(scope.ownerUserId);
      }
      const { status, result } = handleTranslationCommand(req.method, path, body, translationCommandController);

      statusCode = status;
      sendJson(res, statusCode, await result, requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      translationErrorCode = code;
      translationSupabaseStatus = Number.isInteger(error?.supabaseStatus) ? error.supabaseStatus : null;
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      requestLogger({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin,
        errorCode: translationErrorCode,
        supabaseStatus: translationSupabaseStatus
      });
    }
    return;
  }

  if (isExecutionControlRoute(req.method, path)) {
    try {
      assertExecutionControlController(executionControlController);
      const { status, result } = handleExecutionControlCommand(req.method, path, executionControlController);
      statusCode = status;
      sendJson(res, statusCode, serializeExecutionControlResponse(await result), requestId);
    } catch (error) {
      const code = errorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({ level: statusCode >= 500 ? 'error' : 'info', event: 'request', requestId, method: req.method, path, statusCode, durationMs: Math.round(performance.now() - startedAt), clientIp, origin });
    }
    return;
  }

  if (isSavedTranscriptRetranslationRoute(req.method, path)) {
    try {
      if (!savedTranscriptRetranslationController) {
        throw createHttpError('saved_transcript_retranslation_unavailable');
      }

      const body = await readJson(req);
      const sessionId = extractSavedTranscriptRetranslationSessionId(path);
      const result = await savedTranscriptRetranslationController.translateSavedTranscript(
        validateSavedTranscriptRetranslationRequest({ sessionId, body })
      );

      statusCode = 201;
      sendJson(res, statusCode, result, requestId);
    } catch (error) {
      const code = savedTranscriptRetranslationErrorCodeFor(error);
      statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
      sendJson(res, statusCode, errorPayload(code, requestId), requestId);
    } finally {
      logEvent({
        level: statusCode >= 500 ? 'error' : 'info',
        event: 'request',
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        clientIp,
        origin
      });
    }
    return;
  }

  if (process.env.NODE_ENV === 'production' && req.method === 'GET' && !path.startsWith('/api/')) {
    const served = await serveProductionStatic(req, res, path);
    if (served) {
      return;
    }
  }

  if (req.method !== 'POST' || path !== '/api/live-token') {
    statusCode = 404;
    sendJson(res, statusCode, errorPayload('not_found', requestId), requestId);
    return;
  }

  let requestBody = null;
  let requestApiKey = null;
  let liveTokenFailureStage = 'request_start';
  let liveTokenErrorCode = null;
  let liveTokenSessionFound = null;
  let liveTokenBodyMeetingId = null;
  let liveTokenSessionMeetingId = null;
  let liveTokenSessionSegmentId = null;
  try {
    enforceRateLimit(clientIp);

    const body = await readJson(req);
    requestBody = body;
    liveTokenBodyMeetingId = typeof body?.meetingId === 'string' ? body.meetingId : null;
    liveTokenFailureStage = 'authentication';
    if (!authenticatedUser?.id) throw createHttpError('auth_required');
    liveTokenFailureStage = 'request_validation';
    if (typeof body?.meetingId !== 'string' || !body.meetingId.trim() || typeof body?.sessionId !== 'string' || !body.sessionId.trim()) {
      throw createHttpError('recorder_forbidden');
    }
    liveTokenFailureStage = 'session_lookup';
    const detail = typeof sessionRepository?.getSessionRecord === 'function'
      ? await sessionRepository.getSessionRecord(body.sessionId)
      : await sessionReadController?.getSession?.(body.sessionId);
    const session = detail?.sessionRecord || detail?.session;
    liveTokenSessionFound = Boolean(session);
    liveTokenSessionMeetingId = session?.meetingId || null;
    liveTokenSessionSegmentId = session?.segmentId || null;
    if (!session) {
      liveTokenFailureStage = 'session_not_found';
      throw createHttpError('recorder_forbidden');
    }
    if (session.meetingId !== body.meetingId) {
      liveTokenFailureStage = 'session_meeting_mismatch';
      throw createHttpError('recorder_forbidden');
    }
    liveTokenFailureStage = 'recording_permission';
    if (!await meetingMembershipService?.canRecord?.(body.meetingId, authenticatedUser.id)) {
      throw createHttpError('recorder_forbidden');
    }
    liveTokenFailureStage = 'meeting_owner_lookup';
    const ownerUserId = await meetingMembershipService?.getMeetingOwner?.(body.meetingId);
    if (!ownerUserId) throw createHttpError('recorder_forbidden');
    liveTokenFailureStage = 'credential_validation';
    setRequestUser({ ...authenticatedUser, ownerUserId, actorUserId: authenticatedUser.id });
    updateRequestScope(ownerUserId);
    requestApiKey = typeof body?.geminiApiKey === 'string' ? body.geminiApiKey.trim() : body?.geminiApiKey;
    delete body.geminiApiKey;
    if (typeof requestApiKey !== 'string' || requestApiKey.trim() === '') throw createHttpError('server_misconfigured');
    let tokenRequest = body;
    if (hasRecorderHeaders(req)) {
      const sessionId = body?.sessionId;
      const auth = await authorizeRecorderWrite({ req, sessionId, sessionShareService, recorderGrantService, recorderLeaseService });
      if (body.targetLanguageCode && body.targetLanguageCode !== session.targetLanguageCode) throw createHttpError('recorder_session_mismatch');
      if (body.sourceLanguageCode && body.sourceLanguageCode !== session.sourceLanguageCode) throw createHttpError('recorder_session_mismatch');
      tokenRequest = { ...body, targetLanguageCode: session.targetLanguageCode, sourceLanguageCode: session.sourceLanguageCode };
      void auth;
    }
    targetLanguageCode = tokenRequest.targetLanguageCode || 'en';
    const token = await liveTokenCreator(tokenRequest, { apiKey: requestApiKey });
    try {
      observabilityMetrics?.recordCounter(OBSERVABILITY_METRIC_NAMES.GEMINI_REQUEST, 1, { provider: 'gemini', operation: 'token', statusClass: '200' });
      observabilityMetrics?.recordLatency(OBSERVABILITY_METRIC_NAMES.GEMINI_LATENCY, Math.max(0, performance.now() - startedAt), { provider: 'gemini', operation: 'token', statusClass: '200' });
    } catch { /* Metrics are best effort. */ }
    statusCode = 200;
    sendJson(res, statusCode, {
      token: token?.token,
      expiresAt: token?.expiresAt,
      ...(token?.liveConnectModel ? { liveConnectModel: token.liveConnectModel } : {}),
      ...(token?.liveConnectConfig ? { liveConnectConfig: token.liveConnectConfig } : {}),
      ...(Array.isArray(token?.liveGlossaryEntries) ? { liveGlossaryEntries: token.liveGlossaryEntries } : {})
    }, requestId, { 'Cache-Control': 'no-store' });
    logEvent({
      level: 'info',
      event: 'token_issued',
      requestId,
      clientIp,
      origin,
      targetLanguageCode
    });
  } catch (error) {
    const code = errorCodeFor(error);
    liveTokenErrorCode = code;
    try {
      const statusClass = providerStatusClass(error?.status || statusCode);
      observabilityMetrics?.recordCounter(OBSERVABILITY_METRIC_NAMES.GEMINI_REQUEST, 1, { provider: 'gemini', operation: 'token', statusClass });
      observabilityMetrics?.recordCounter(OBSERVABILITY_METRIC_NAMES.GEMINI_FAILURE, 1, { provider: 'gemini', operation: 'token', statusClass });
      observabilityMetrics?.recordLatency(OBSERVABILITY_METRIC_NAMES.GEMINI_LATENCY, Math.max(0, performance.now() - startedAt), { provider: 'gemini', operation: 'token', statusClass });
    } catch { /* Metrics are best effort. */ }
    statusCode = ERROR_RESPONSES[code]?.status || error.status || 500;
    if (code === 'provider_unavailable') {
      logProviderError(requestId, error, {
        hasSupabaseAccessToken: /^Bearer\s+\S+$/i.test(String(req.headers?.authorization || '')),
        hasGeminiApiKey: typeof requestApiKey === 'string' && requestApiKey.length > 0,
        geminiApiKeyLength: typeof requestApiKey === 'string' ? requestApiKey.length : 0,
        model: process.env.LIVE_TRANSLATE_MODEL || DEFAULT_LIVE_TRANSLATE_MODEL,
        logger: requestLogger
      });
    }
    sendJson(res, statusCode, errorPayload(code, requestId), requestId, { 'Cache-Control': 'no-store' });
  } finally {
    requestApiKey = null;
    if (requestBody && typeof requestBody === 'object') delete requestBody.geminiApiKey;
    logEvent({
      level: statusCode >= 500 ? 'error' : 'info',
      event: 'request',
      requestId,
      method: req.method,
      path,
      statusCode,
      durationMs: Math.round(performance.now() - startedAt),
      clientIp,
      origin,
      targetLanguageCode,
      errorCode: liveTokenErrorCode,
      failureStage: liveTokenErrorCode ? liveTokenFailureStage : null,
      sessionFound: liveTokenSessionFound,
      bodyMeetingId: liveTokenBodyMeetingId,
      sessionMeetingId: liveTokenSessionMeetingId,
      sessionSegmentId: liveTokenSessionSegmentId,
      meetingId: requestBody?.meetingId || null,
      sessionId: requestBody?.sessionId || null
    });
  }
}

function assertTranslationCommandController(translationCommandController) {
  if (!translationCommandController) {
    throw new TypeError('translationCommandController is required.');
  }

  assertMethod(translationCommandController, 'createTranslationRequest');
  assertMethod(translationCommandController, 'createTranslationExecution');
  assertMethod(translationCommandController, 'updateTranslationExecution');
  assertMethod(translationCommandController, 'createTranslationOutput');
}

function assertExecutionControlController(executionControlController) {
  if (!executionControlController) {
    throw new TypeError('executionControlController is required.');
  }
  for (const methodName of ['cancelExecution', 'retryExecution']) {
    if (typeof executionControlController[methodName] !== 'function') {
      throw new TypeError(`executionControlController.${methodName} must be a function.`);
    }
  }
}

function assertMethod(target, methodName) {
  if (typeof target[methodName] !== 'function') {
    throw new TypeError(`translationCommandController.${methodName} must be a function.`);
  }
}

function isTranslationCommandRoute(method, path) {
  return (
    (method === 'POST' && path === '/api/translation-requests') ||
    (method === 'POST' && path === '/api/translation-executions') ||
    (method === 'PATCH' &&
      path.startsWith('/api/translation-executions/') &&
      path.length > '/api/translation-executions/'.length) ||
    (method === 'POST' && path === '/api/translation-outputs')
  );
}

function isExecutionControlRoute(method, path) {
  return method === 'POST'
    && path.startsWith('/api/translation-executions/')
    && (path.endsWith('/cancel') || path.endsWith('/retry'));
}

function isDeadLetterQueueRoute(method, path) {
  return (method === 'GET' && path === '/api/translation-dead-letter-queue') ||
    (method === 'POST' && path.startsWith('/api/translation-dead-letter-queue/') && path.endsWith('/replay'));
}

function isPublicApiPath(method, path) {
  return (method === 'GET' && (
    isSharedSessionDetailPath(path) ||
    isSharedSessionEventsPath(path) ||
    isSharedMeetingDetailPath(path) ||
    isSharedMeetingEventsPath(path)
  )) || (method === 'POST' && (path === '/api/auth-events' || isSharedMeetingRealtimeTokenPath(path) || isSharedMeetingTelemetryPath(path))) || isRecorderLeasePath(method, path) || isSharedMeetingStartPath(path);
}

async function authorizeTranslationResource({ req, path, body, user, meetingMembershipService, translationRepository, meetingRepository }) {
  if (!user?.id || !translationRepository) return null;
  let sessionId = body?.sessionId;
  let executionId = body?.executionId;
  if (path.startsWith('/api/translation-executions/')) {
    executionId = safeDecodePathComponent(path.slice('/api/translation-executions/'.length).split('/')[0]);
  } else if (path.includes('/translation-dead-letter-queue/')) {
    executionId = extractDeadLetterExecutionId(path);
  }
  if (executionId && typeof translationRepository.findExecutionById === 'function') {
    const execution = await translationRepository.findExecutionById(executionId);
    if (!execution) throw createHttpError('auth_forbidden');
    if (typeof translationRepository.findRequestById === 'function') {
      const request = await translationRepository.findRequestById(execution.translationRequestId);
      sessionId ||= request?.sessionId;
    }
  }
  if (!sessionId && body?.translationRequestId && typeof translationRepository.findRequestById === 'function') {
    const request = await translationRepository.findRequestById(body.translationRequestId);
    sessionId = request?.sessionId;
  }
  if (!sessionId) return null;
  const context = await meetingMembershipService.getSessionOwner(sessionId);
  if (!context?.meetingId || !context.ownerUserId) throw createHttpError('auth_forbidden');
  if (!await meetingMembershipService.canManage(context.meetingId, user)) throw createHttpError('auth_forbidden');
  if (isMeetingContentExpired(await readAuthorizedMeeting(meetingRepository, context.meetingId, context.ownerUserId, user))) throw meetingContentExpiredError();
  return { ownerUserId: context.ownerUserId };
}

async function authorizePrivateResource({ req, path, user, meetingMembershipService, meetingDeletionService, meetingRepository }) {
  const meetingMatch = path.match(/^\/api\/meetings\/([^/]+)/u);
  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)/u);
  if (meetingMatch && meetingMatch[1] !== 'glossary') {
    const meetingId = safeDecodePathComponent(meetingMatch[1]);
    if (req.method === 'DELETE' && isMeetingDetailPath(path)) {
      const tombstone = await meetingDeletionService?.getDeletionTombstone?.(meetingId);
      if (tombstone?.state === 'deleted') {
        if (user?.id !== tombstone.ownerUserId && user?.role !== 'super_admin') throw createHttpError('auth_forbidden');
        return { ownerUserId: tombstone.ownerUserId };
      }
    }
    const canRecord = isMemberMeetingRecordingPath(req.method, path);
    const canEditSettings = req.method === 'GET' || req.method === 'PATCH';
    const canManageShares = isMeetingShareCollectionPath(path) && (req.method === 'GET' || req.method === 'POST');
    const allowed = canRecord
      ? await meetingMembershipService.canRecord(meetingId, user.id)
      : canEditSettings || canManageShares
        ? await canAccessMeeting(meetingMembershipService, meetingId, user)
        : await meetingMembershipService.canManage(meetingId, user);
    if (!allowed) throw createHttpError(canRecord ? 'recorder_forbidden' : 'auth_forbidden');
    const ownerUserId = await meetingMembershipService.getMeetingOwner(meetingId);
    if (!ownerUserId) {
      throw createHttpError(user.role === 'super_admin' ? 'meeting_not_found' : (canRecord ? 'recorder_forbidden' : 'auth_forbidden'));
    }
    if (!(req.method === 'GET' && isMeetingDetailPath(path)) &&
      !(req.method === 'DELETE' && isMeetingDetailPath(path)) &&
      !(req.method === 'PATCH' && isMeetingDetailPath(path))) {
      const meeting = await readAuthorizedMeeting(meetingRepository, meetingId, ownerUserId, user);
      if (isMeetingContentExpired(meeting)) throw meetingContentExpiredError();
    }
    return { ownerUserId };
  }
  if (sessionMatch && sessionMatch[1] !== 'shares') {
    const sessionId = safeDecodePathComponent(sessionMatch[1]);
    const context = await meetingMembershipService.getSessionOwner(sessionId);
    const meetingId = context?.meetingId;
    const ownerUserId = context?.ownerUserId;
    if (meetingId) {
      const canRecord = isMemberSessionRecordingPath(req.method, path);
      const allowed = canRecord
        ? await meetingMembershipService.canRecord(meetingId, user.id)
        : await meetingMembershipService.canManage(meetingId, user);
      if (!allowed) throw createHttpError(canRecord ? 'recorder_forbidden' : 'auth_forbidden');
      if (ownerUserId) {
        if (isMeetingContentExpired(await readAuthorizedMeeting(meetingRepository, meetingId, ownerUserId, user))) throw meetingContentExpiredError();
        return { ownerUserId };
      }
    }
  }
  return null;
}

async function readAuthorizedMeeting(meetingRepository, meetingId, ownerUserId, user) {
  if (!meetingRepository || !ownerUserId) return null;
  return runWithRequestUser({
    ...user,
    requestScope: {
      ...currentRequestScope(),
      resourceOwnerUserId: ownerUserId
    }
  }, () => meetingRepository.getMeeting(meetingId));
}

async function canAccessMeeting(meetingMembershipService, meetingId, user) {
  if (typeof meetingMembershipService?.canAccessMeeting === 'function') {
    return meetingMembershipService.canAccessMeeting(meetingId, user);
  }
  return meetingMembershipService?.canManage?.(meetingId, user);
}

async function meetingPermissionsFor(meetingId, user, meetingMembershipService) {
  const canAccess = await canAccessMeeting(meetingMembershipService, meetingId, user);
  const canManage = await meetingMembershipService?.canManage?.(meetingId, user);
  return {
    canEditSettings: canAccess,
    canViewShares: canAccess,
    canManageShares: Boolean(canManage),
    canManageMembers: Boolean(canManage),
    canDelete: Boolean(canManage),
    canComplete: Boolean(canManage)
  };
}

async function resolveMeetingLifecyclePrincipal({
  req,
  meetingId,
  authenticatedUser,
  meetingMembershipService,
  sessionShareService
} = {}) {
  if (hasRecorderHeaders(req)) {
    const code = req.headers?.['x-recorder-code'];
    const token = req.headers?.['x-recorder-token'];
    const share = code
      ? await sessionShareService?.resolveCode?.(code)
      : await sessionShareService?.resolveShare?.(token);
    if (!share || share.resourceType !== 'meeting' || share.meetingId !== meetingId || share.role !== 'recorder') {
      throw createHttpError('recorder_forbidden');
    }
    if (!share._ownerUserId) throw createHttpError('meeting_share_invalid');
    return {
      ownerUserId: share._ownerUserId,
      principalType: 'share',
      principalId: share.id,
      forceAllowed: false
    };
  }

  if (!authenticatedUser?.id) throw createHttpError('auth_required');
  const ownerUserId = currentRequestOwnerId();
  if (!ownerUserId) throw createHttpError('auth_forbidden');
  const canForce = authenticatedUser.role === 'super_admin'
    || await meetingMembershipService?.canManage?.(meetingId, authenticatedUser);
  return {
    ownerUserId,
    principalType: 'user',
    principalId: authenticatedUser.id,
    forceAllowed: Boolean(canForce)
  };
}

function isRecorderAuthorizedPath(method, path, req) {
  if (!hasRecorderHeaders(req)) return false;
  if (method === 'PUT' && /^\/api\/sessions\/[^/]+$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/audio\/(input|translation)$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/audio\/(input|translation)\/segments\/\d+$/.test(path)) return true;
  if (method === 'PUT' && /^\/api\/meetings\/[^/]+\/segments\/[^/]+\/checkpoint$/.test(path)) return true;
  if (method === 'POST' && isMeetingCuePublishPath(path)) return true;
  if (method === 'POST' && /^\/api\/meetings\/[^/]+\/segments\/[^/]+\/(rollover|recover)$/.test(path)) return true;
  if (method === 'POST' && (isMeetingRecordingCommandPath(path) || isMeetingLifecycleHeartbeatPath(path))) return true;
  return false;
}

function isMemberMeetingRecordingPath(method, path) {
  return (method === 'POST' && (isMeetingRecordingCommandPath(path) || isMeetingLifecycleHeartbeatPath(path))) ||
    (method === 'POST' && isMeetingCuePublishPath(path)) ||
    (method === 'PUT' && /^\/api\/meetings\/[^/]+\/segments\/[^/]+\/checkpoint$/.test(path)) ||
    (method === 'POST' && /^\/api\/meetings\/[^/]+\/segments\/[^/]+\/(rollover|recover)$/.test(path)) ||
    (method === 'POST' && /^\/api\/meetings\/[^/]+\/segments\/[^/]+\/audio-uploads$/.test(path)) ||
    (method === 'POST' && /^\/api\/meetings\/[^/]+\/audio-artifacts\/[^/]+\/(complete|fail)$/.test(path));
}

function isMemberSessionRecordingPath(method, path) {
  return (method === 'PUT' && /^\/api\/sessions\/[^/]+$/.test(path)) ||
    (method === 'POST' && /^\/api\/sessions\/[^/]+\/audio\/(input|translation)(?:\/segments\/\d+)?$/.test(path));
}

function extractSessionRecordingId(path) {
  const match = path.match(/^\/api\/sessions\/([^/]+)/);
  if (!match) throw createHttpError('invalid_request');
  return safeDecodePathComponent(match[1]);
}

function extractMemberMeetingId(path) {
 const match = path.match(/^\/api\/meetings\/([^/]+)/);
 if (!match) throw createHttpError('invalid_request');
 return safeDecodePathComponent(match[1]);
}

async function authorizeRecorderWrite({ req, sessionId, sessionShareService, recorderGrantService, recorderLeaseService }) {
  if (!hasRecorderHeaders(req)) return null;
  return authorizeRecorderRequest({
    request: req,
    sessionId,
    sessionShareService,
    recorderGrantService,
    recorderLeaseService
  });
}

async function authorizeRecorderMeetingWrite({ req, meetingId, segmentId, sessionRepository, sessionShareService, recorderGrantService, recorderLeaseService }) {
  if (!hasRecorderHeaders(req)) return null;
  const sessionId = req.headers?.['x-recorder-session-id'];
  const existing = await sessionRepository?.getSessionRecord?.(sessionId);
  if (!existing?.sessionRecord || existing.sessionRecord.meetingId !== meetingId || existing.sessionRecord.segmentId !== segmentId) {
    throw createHttpError('recorder_session_mismatch');
  }
  return authorizeRecorderWrite({ req, sessionId, sessionShareService, recorderGrantService, recorderLeaseService });
}

function validateRecorderSnapshot(existingSession, body) {
  if (!existingSession) throw createHttpError('session_not_found');
  const incoming = body?.session || {};
  for (const field of ['name', 'sourceLanguageCode', 'targetLanguageCode', 'targetLanguageLabel']) {
    if (incoming[field] !== undefined && incoming[field] !== (existingSession[field] ?? null)) {
      throw createHttpError('recorder_forbidden');
    }
  }
}

function isRecorderLeasePath(method, path) {
  return (method === 'POST' && /^\/api\/shared-sessions\/(?:code\/)?[^/]+\/recorder-lease(?:\/heartbeat)?$/.test(path)) ||
    (method === 'DELETE' && /^\/api\/shared-sessions\/(?:code\/)?[^/]+\/recorder-lease$/.test(path));
}

function decodeRecorderToken(path) {
  const match = path.match(/^\/api\/shared-sessions\/([^/]+)\/recorder-lease/);
  if (!match) throw createHttpError('invalid_request');
  return decodeURIComponent(match[1]);
}

async function resolveRecorderShare(path, sessionShareService) {
  if (path.startsWith('/api/shared-sessions/code/')) {
    const match = path.match(/^\/api\/shared-sessions\/code\/([^/]+)\/recorder-lease/);
    if (!match) throw createHttpError('invalid_request');
    return sessionShareService.resolveCode(decodeURIComponent(match[1]));
  }
  return sessionShareService.resolveShare(decodeRecorderToken(path));
}

function isSavedTranscriptRetranslationRoute(method, path) {
  return method === 'POST' && path.startsWith('/api/saved-transcripts/') && path.endsWith('/translations');
}

function isSessionTranslationHistoryPath(path) {
  return path.startsWith('/api/sessions/') && path.endsWith('/translations') && path.length > '/api/sessions//translations'.length;
}

function isSessionTranslationOutputPath(path) {
  return path.startsWith('/api/sessions/') && path.includes('/translations/') && path.length > '/api/sessions//translations/'.length;
}

function isSessionRetranslationPath(path) {
  return path.startsWith('/api/sessions/') && path.endsWith('/retranslations') && path.length > '/api/sessions//retranslations'.length;
}

function isSessionAudioPath(path) {
  return path.startsWith('/api/sessions/') && path.includes('/audio/') && !path.includes('/segments/') && path.length > '/api/sessions//audio/'.length;
}

function parseSessionAudioPath(path) {
  const prefix = '/api/sessions/';
  const separator = path.indexOf('/audio/', prefix.length);
  if (separator <= prefix.length) throw createHttpError('invalid_request');
  return {
    sessionId: safeDecodePathComponent(path.slice(prefix.length, separator)),
    kind: validateAudioArtifactKind(path.slice(separator + '/audio/'.length))
  };
}

function isSessionAudioSegmentPath(path) {
  return path.startsWith('/api/sessions/') && path.includes('/audio/') && path.includes('/segments/');
}

function parseSessionAudioSegmentPath(path) {
  const prefix = '/api/sessions/';
  const audioSeparator = path.indexOf('/audio/', prefix.length);
  const segmentSeparator = path.indexOf('/segments/', audioSeparator + '/audio/'.length);
  if (audioSeparator <= prefix.length || segmentSeparator <= audioSeparator) throw createHttpError('invalid_request');
  const rawSegmentIndex = path.slice(segmentSeparator + '/segments/'.length);
  if (!/^\d+$/.test(rawSegmentIndex)) throw createHttpError('invalid_request');
  const segmentIndex = Number.parseInt(rawSegmentIndex, 10);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) throw createHttpError('invalid_request');
  return {
    sessionId: safeDecodePathComponent(path.slice(prefix.length, audioSeparator)),
    kind: validateAudioArtifactKind(path.slice(audioSeparator + '/audio/'.length, segmentSeparator)),
    segmentIndex
  };
}

function isMeetingAudioPath(path) {
  return path.startsWith('/api/meetings/') && path.includes('/audio/') && path.length > '/api/meetings//audio/'.length;
}

function isMeetingAudioUploadStartPath(path) {
  return /^\/api\/meetings\/[^/]+\/segments\/[^/]+\/audio-uploads$/u.test(path);
}

function parseMeetingAudioUploadStartPath(path) {
  const match = path.match(/^\/api\/meetings\/([^/]+)\/segments\/([^/]+)\/audio-uploads$/u);
  if (!match) throw createHttpError('invalid_request');
  return { meetingId: safeDecodePathComponent(match[1]), segmentId: safeDecodePathComponent(match[2]) };
}

function isMeetingAudioArtifactActionPath(path) {
  return /^\/api\/meetings\/[^/]+\/audio-artifacts\/[^/]+\/(complete|fail|retry|download-url)$/u.test(path);
}

function parseMeetingAudioArtifactActionPath(path) {
  const match = path.match(/^\/api\/meetings\/([^/]+)\/audio-artifacts\/([^/]+)\/(complete|fail|retry|download-url)$/u);
  if (!match) throw createHttpError('invalid_request');
  return {
    meetingId: safeDecodePathComponent(match[1]),
    artifactId: safeDecodePathComponent(match[2]),
    action: match[3]
  };
}

function parseMeetingAudioPath(path) {
  const prefix = '/api/meetings/';
  const separator = path.indexOf('/audio/', prefix.length);
  if (separator <= prefix.length) throw createHttpError('invalid_request');
  return {
    meetingId: safeDecodePathComponent(path.slice(prefix.length, separator)),
    kind: validateAudioArtifactKind(path.slice(separator + '/audio/'.length))
  };
}

function isMeetingDetailPath(path) {
  const prefix = '/api/meetings/';
  if (!path.startsWith(prefix) || path.length <= prefix.length) {
    return false;
  }

  return !path.slice(prefix.length).includes('/');
}

function isMeetingCompletePath(path) {
  return path.startsWith('/api/meetings/') && path.endsWith('/complete') && path.split('/').length === 5;
}

function isMeetingRecordingCommandPath(path) {
  return /^\/api\/meetings\/[^/]+\/recording\/(?:start|pause|resume|rollover|recover|stop|takeover|lease\/heartbeat)$/u.test(path);
}

function isMeetingLifecycleHeartbeatPath(path) {
  return /^\/api\/meetings\/[^/]+\/heartbeat$/u.test(path);
}

function parseMeetingLifecyclePath(path) {
  const commandMatch = path.match(/^\/api\/meetings\/([^/]+)\/recording\/(start|pause|resume|rollover|recover|stop|takeover|lease\/heartbeat)$/u);
  if (commandMatch) {
    return {
      meetingId: safeDecodePathComponent(commandMatch[1]),
      action: commandMatch[2] === 'lease/heartbeat' ? 'lease-heartbeat' : commandMatch[2]
    };
  }
  const heartbeatMatch = path.match(/^\/api\/meetings\/([^/]+)\/heartbeat$/u);
  if (!heartbeatMatch) throw createHttpError('invalid_request');
  return { meetingId: safeDecodePathComponent(heartbeatMatch[1]), action: 'liveness' };
}

function isMeetingLifecycleFencedWrite(method, path) {
  return (method === 'POST' && /^\/api\/meetings\/[^/]+\/segments\/[^/]+\/cues$/u.test(path)) ||
    (method === 'PUT' && /^\/api\/meetings\/[^/]+\/segments\/[^/]+\/checkpoint$/u.test(path)) ||
    (method === 'POST' && /^\/api\/meetings\/[^/]+\/segments\/[^/]+\/audio-uploads$/u.test(path));
}

function parseMeetingLifecycleFencedWritePath(path) {
  const segmentMatch = path.match(/^\/api\/meetings\/([^/]+)\/segments\/([^/]+)\/(?:cues|checkpoint|audio-uploads)$/u);
  if (segmentMatch) {
    return {
      meetingId: safeDecodePathComponent(segmentMatch[1]),
      segmentId: safeDecodePathComponent(segmentMatch[2])
    };
  }
  throw createHttpError('invalid_request');
}

function isMeetingShareCollectionPath(path) {
  return path.startsWith('/api/meetings/') && path.endsWith('/shares') && path.split('/').length === 5;
}

function isMeetingSharePath(path) {
  return /^\/api\/meetings\/[^/]+\/shares\/[^/]+$/.test(path);
}

function isMeetingCuePublishPath(path) {
  return /^\/api\/meetings\/[^/]+\/segments\/[^/]+\/cues$/.test(path);
}

function parseMeetingCuePublishPath(path) {
  const match = path.match(/^\/api\/meetings\/([^/]+)\/segments\/([^/]+)\/cues$/);
  if (!match) throw createHttpError('invalid_request');
  return { meetingId: safeDecodePathComponent(match[1]), segmentId: safeDecodePathComponent(match[2]) };
}

function parseMeetingShareCollectionPath(path) {
  const prefix = '/api/meetings/';
  return safeDecodePathComponent(path.slice(prefix.length, -'/shares'.length));
}

function parseMeetingSharePath(path) {
  const match = path.match(/^\/api\/meetings\/([^/]+)\/shares\/([^/]+)$/);
  if (!match) throw createHttpError('invalid_request');
  return {
    meetingId: safeDecodePathComponent(match[1]),
    shareId: safeDecodePathComponent(match[2])
  };
}

async function listMeetingAudioArtifacts({ sessionRepository, meetingRepository, meetingId, kind }) {
  const records = await sessionRepository.listSessionRecords();
  const segments = meetingRepository && typeof meetingRepository.listMeetingSegments === 'function'
    ? await meetingRepository.listMeetingSegments(meetingId)
    : [];
  const orderByLiveSessionId = new Map(segments.map((segment) => [segment.liveSessionId, segment.sequence]));

  return records
    .filter((sessionRecord) => sessionRecord?.meetingId === meetingId && sessionRecord.audioArtifacts?.[kind])
    .sort((left, right) => (
      (orderByLiveSessionId.get(left.liveSessionId) ?? Number.MAX_SAFE_INTEGER) -
        (orderByLiveSessionId.get(right.liveSessionId) ?? Number.MAX_SAFE_INTEGER) ||
      timestampValue(left.startedAt) - timestampValue(right.startedAt) ||
      String(left.id).localeCompare(String(right.id))
    ))
    .map((record) => record.audioArtifacts[kind]);
}

function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMeetingSegmentsPath(path) {
  return path.startsWith('/api/meetings/') && path.endsWith('/segments') && path.length > '/api/meetings//segments'.length;
}

function isMeetingSegmentCheckpointPath(path) {
  return path.startsWith('/api/meetings/') &&
    path.includes('/segments/') &&
    path.endsWith('/checkpoint') &&
    path.length > '/api/meetings//segments//checkpoint'.length;
}

function isMeetingSegmentRolloverPath(path) {
  return path.startsWith('/api/meetings/') &&
    path.includes('/segments/') &&
    path.endsWith('/rollover') &&
    path.length > '/api/meetings//segments//rollover'.length;
}

function isMeetingSegmentStartPath(path) {
  return path.startsWith('/api/meetings/') && path.includes('/segments/') && path.endsWith('/start');
}

function isMeetingSegmentRecoverPath(path) {
  return path.startsWith('/api/meetings/') &&
    path.includes('/segments/') &&
    path.endsWith('/recover') &&
    path.length > '/api/meetings//segments//recover'.length;
}

function parseMeetingSegmentsPath(path) {
  const prefix = '/api/meetings/';
  const suffix = '/segments';
  return {
    meetingId: safeDecodePathComponent(path.slice(prefix.length, -suffix.length))
  };
}

function parseMeetingDetailPath(path) {
  const prefix = '/api/meetings/';
  return {
    meetingId: safeDecodePathComponent(path.slice(prefix.length))
  };
}

function parseMeetingCompletePath(path) {
  const prefix = '/api/meetings/';
  return {
    meetingId: safeDecodePathComponent(path.slice(prefix.length, -'/complete'.length))
  };
}

function parseMeetingSegmentCheckpointPath(path, { strictIds = true } = {}) {
  const prefix = '/api/meetings/';
  const suffix = '/checkpoint';
  const body = path.slice(prefix.length, -suffix.length);
  const separator = body.indexOf('/segments/');
  if (separator <= 0) throw createHttpError('invalid_request');

  const meetingId = safeDecodePathComponent(body.slice(0, separator));
  const segmentId = safeDecodePathComponent(body.slice(separator + '/segments/'.length));
  if (!meetingId) throw createHttpError('invalid_request', ['meetingId must be a non-empty path parameter.']);
  if (!segmentId) throw createHttpError('invalid_request', ['segmentId must be a non-empty path parameter.']);
  if (strictIds) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
    if (!uuidPattern.test(meetingId)) throw createHttpError('invalid_request', ['meetingId must be a valid UUID.']);
    if (!uuidPattern.test(segmentId)) throw createHttpError('invalid_request', ['segmentId must be a valid UUID.']);
  }
  return { meetingId, segmentId };
}

function parseMeetingSegmentRolloverPath(path) {
  const prefix = '/api/meetings/';
  const suffix = '/rollover';
  const body = path.slice(prefix.length, -suffix.length);
  const separator = body.indexOf('/segments/');
  if (separator <= 0) throw createHttpError('invalid_request');

  return {
    meetingId: safeDecodePathComponent(body.slice(0, separator)),
    segmentId: safeDecodePathComponent(body.slice(separator + '/segments/'.length))
  };
}

function parseMeetingSegmentStartPath(path) {
  const prefix = '/api/meetings/';
  const body = path.slice(prefix.length, -'/start'.length);
  const separator = body.indexOf('/segments/');
  if (separator <= 0) throw createHttpError('invalid_request');
  return {
    meetingId: safeDecodePathComponent(body.slice(0, separator)),
    segmentId: safeDecodePathComponent(body.slice(separator + '/segments/'.length))
  };
}

function parseMeetingSegmentRecoverPath(path) {
  const prefix = '/api/meetings/';
  const suffix = '/recover';
  const body = path.slice(prefix.length, -suffix.length);
  const separator = body.indexOf('/segments/');
  if (separator <= 0) throw createHttpError('invalid_request');

  return {
    meetingId: safeDecodePathComponent(body.slice(0, separator)),
    segmentId: safeDecodePathComponent(body.slice(separator + '/segments/'.length))
  };
}

function safeDecodePathComponent(value) {
  try {
    return validateRequiredString(decodeURIComponent(value));
  } catch (error) {
    if (error?.code === 'invalid_request') throw error;
    throw createHttpError('invalid_request');
  }
}

function isGlossaryRoute(method, path) {
  return (
    (method === 'POST' && (path === '/api/glossary/import/preview' || path === '/api/glossary/import')) ||
    (method === 'GET' && path === '/api/glossary') ||
    (method === 'GET' && path === '/api/glossary/categories') ||
    (method === 'POST' && path === '/api/glossary/categories') ||
    (method === 'PUT' && path === '/api/glossary/categories/order') ||
    ((method === 'PUT' || method === 'DELETE') && path.startsWith('/api/glossary/categories/') && path.length > '/api/glossary/categories/'.length) ||
    (method === 'POST' && path === '/api/glossary/entries') ||
    ((method === 'PUT' || method === 'DELETE') &&
      path.startsWith('/api/glossary/entries/') &&
      path.length > '/api/glossary/entries/'.length)
  );
}

async function handleGlossaryCommand(method, path, req, glossaryController) {
  if (method === 'POST' && (path === '/api/glossary/import/preview' || path === '/api/glossary/import')) {
    const body = await readJson(req, { maxBytes: GLOSSARY_IMPORT_MAX_BYTES });
    if (!isPlainRequestObject(body) || (body.format !== 'csv' && body.format !== 'json' && body.format !== 'xlsx') || typeof body.content !== 'string' || typeof body.sourceLanguageCode !== 'string' || typeof body.targetLanguageCode !== 'string' || typeof body.category !== 'string') throw createHttpError('invalid_request');
    validateSupportedTargetLanguageCode(body.sourceLanguageCode);
    validateSupportedTargetLanguageCode(body.targetLanguageCode);
    validateGlossaryCategory(body.category);
    if (path.endsWith('/preview')) return { status: 200, result: await glossaryController.previewImport(body) };
    if (typeof body.baseRevision !== 'string' || !isPlainRequestObject(body.resolutions) || (body.selectedRows !== undefined && (!Array.isArray(body.selectedRows) || body.selectedRows.some((rowNumber) => !Number.isInteger(rowNumber) || rowNumber < 1)))) throw createHttpError('invalid_request');
    return { status: 200, result: await glossaryController.importEntries(body) };
  }

  if (method === 'GET' && path === '/api/glossary/categories') {
    return { status: 200, result: { categories: await glossaryController.listCategories() } };
  }

  if (method === 'POST' && path === '/api/glossary/categories') {
    return { status: 201, result: { category: await glossaryController.createCategory(validateGlossaryCategoryBody(await readJson(req))) } };
  }

  if (method === 'PUT' && path === '/api/glossary/categories/order') {
    const body = await readJson(req);
    if (!isPlainRequestObject(body) || !Array.isArray(body.categoryIds)) throw createHttpError('invalid_request');
    return { status: 200, result: { categories: await glossaryController.reorderCategories(body.categoryIds) } };
  }

  if (method === 'PUT' && path.startsWith('/api/glossary/categories/')) {
    const id = extractGlossaryCategoryId(path);
    return { status: 200, result: { category: await glossaryController.updateCategory({ id, ...validateGlossaryCategoryBody(await readJson(req), { allowId: false }) }) } };
  }

  if (method === 'DELETE' && path.startsWith('/api/glossary/categories/')) {
    const id = extractGlossaryCategoryId(path);
    return { status: 200, result: await glossaryController.deleteCategory({ id }) };
  }

  if (method === 'GET' && path === '/api/glossary') {
    return { status: 200, result: { entries: await glossaryController.listEntries() } };
  }

  if (method === 'POST' && path === '/api/glossary/entries') {
    return { status: 201, result: { entry: await glossaryController.createEntry(validateGlossaryEntryBody(await readJson(req))) } };
  }

  if (method === 'PUT' && path.startsWith('/api/glossary/entries/')) {
    const id = extractGlossaryEntryId(path);
    return { status: 200, result: { entry: await glossaryController.updateEntry({ id, ...validateGlossaryEntryBody(await readJson(req)) }) } };
  }

  if (method === 'DELETE' && path.startsWith('/api/glossary/entries/')) {
    const id = extractGlossaryEntryId(path);
    return { status: 200, result: { entry: await glossaryController.deleteEntry({ id }) } };
  }

  throw createHttpError('not_found');
}

function extractGlossaryCategoryId(path) {
  try {
    return validateRequiredString(decodeURIComponent(path.slice('/api/glossary/categories/'.length)));
  } catch (error) {
    if (error?.code === 'invalid_request') throw error;
    throw createHttpError('invalid_request');
  }
}

function validateGlossaryCategoryBody(body) {
  if (!isPlainRequestObject(body)) throw createHttpError('invalid_request');
  const label = validateRequiredString(body.label).trim();
  if (Object.hasOwn(body, 'id')) validateRequiredString(body.id);
  return { ...(Object.hasOwn(body, 'id') ? { id: body.id } : {}), label, system: body.system === true };
}

function extractGlossaryEntryId(path) {
  try {
    return validateRequiredString(decodeURIComponent(path.slice('/api/glossary/entries/'.length)));
  } catch (error) {
    if (error?.code === 'invalid_request') throw error;
    throw createHttpError('invalid_request');
  }
}

function validateGlossaryEntryBody(body) {
  if (!isPlainRequestObject(body) || !isPlainRequestObject(body.translations)) throw createHttpError('invalid_request');
  validateRequiredString(body.source);
  const scope = body.scope === undefined ? 'history' : body.scope;
  if (!['live', 'history', 'both'].includes(scope)) throw createHttpError('invalid_request');
  for (const [languageCode, translation] of Object.entries(body.translations)) {
    if (!isSupportedLanguage(languageCode)) throw createHttpError('unsupported_language');
    validateRequiredString(translation);
  }
  if (Object.keys(body.translations).length === 0) throw createHttpError('invalid_request');
  const replacementAliases = validateGlossaryReplacementAliases(body.replacementAliases);
  return {
    source: body.source,
    sourceLanguageCode: body.sourceLanguageCode === undefined ? 'zh-Hant' : validateSupportedTargetLanguageCode(body.sourceLanguageCode),
    translations: body.translations,
    ...(hasReplacementAliases(replacementAliases) ? { replacementAliases } : {}),
    scope,
    category: body.category === undefined ? 'other' : validateGlossaryCategory(body.category),
    tags: body.tags === undefined ? [] : validateGlossaryTags(body.tags),
    enabled: body.enabled === undefined ? true : validateBoolean(body.enabled),
    notes: body.notes === undefined ? '' : validateOptionalString(body.notes)
  };
}

function validateGlossaryCategory(value) {
  const legacyCategoryPattern = /^[a-z][a-z0-9_-]*$/;
  const cloudCategoryPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (typeof value !== 'string' || (!legacyCategoryPattern.test(value) && !cloudCategoryPattern.test(value))) {
    throw createHttpError('invalid_request');
  }
  return value;
}

function validateGlossaryTags(value) {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string' || tag.trim() === '')) throw createHttpError('invalid_request');
  return value.map((tag) => tag.trim());
}

function validateBoolean(value) {
  if (typeof value !== 'boolean') throw createHttpError('invalid_request');
  return value;
}

function validateOptionalString(value) {
  if (typeof value !== 'string') throw createHttpError('invalid_request');
  return value;
}

function validateGlossaryReplacementAliases(value) {
  if (value === undefined) return {};
  if (!isPlainRequestObject(value)) throw createHttpError('invalid_request');

  const replacementAliases = {};
  for (const [languageCode, aliases] of Object.entries(value)) {
    if (!isSupportedLanguage(languageCode)) throw createHttpError('unsupported_language');
    if (!Array.isArray(aliases)) throw createHttpError('invalid_request');
    replacementAliases[languageCode] = aliases.map((alias) => validateRequiredString(alias));
  }
  return replacementAliases;
}

function hasReplacementAliases(replacementAliases) {
  return Object.values(replacementAliases)
    .some((aliases) => Array.isArray(aliases) && aliases.length > 0);
}

function extractSessionRetranslationSessionId(path) {
  try { return decodeURIComponent(path.slice('/api/sessions/'.length, -'/retranslations'.length)); }
  catch { throw createHttpError('invalid_request'); }
}

function validateSessionRetranslationRequest({ sessionId, body }) {
  if (!isPlainRequestObject(body) || ['sourceText', 'sourceLanguageCode', 'transcriptItems', 'sessionId'].some((key) => Object.hasOwn(body, key))) {
    throw createHttpError('invalid_request');
  }
  return {
    sessionId: validateRequiredString(sessionId),
    targetLanguageCode: validateSupportedTargetLanguageCode(body.targetLanguageCode),
    providerKey: body.providerKey
  };
}

function legacyTranslationFallback(outputs) {
  return (Array.isArray(outputs) ? outputs : []).map((output) => ({
    id: output.id,
    targetLanguageCode: output.targetLanguageCode,
    version: null,
    source: 'legacy',
    translatedText: Array.isArray(output.items) ? output.items.map((item) => item?.text).filter(Boolean).join('\n') : null,
    completedAt: output.completedAt ?? output.createdAt ?? null
  }));
}

function isLiveSessionTranslationOutput(output) {
  return typeof output?.id === 'string' && output.id.startsWith('live-output:');
}

function applyFormalOutputReadModel(session, outputs) {
  const formalOutput = (Array.isArray(outputs) ? outputs : []).find((output) => output?.source === 'formal' || Number.isInteger(output?.version));
  if (!formalOutput || typeof formalOutput.translatedText !== 'string' || formalOutput.translatedText.trim().length === 0) {
    return;
  }

  const selectedTranslationOutput = {
    id: formalOutput.id,
    executionId: formalOutput.executionId,
    translationRequestId: formalOutput.requestId,
    requestId: formalOutput.requestId,
    sessionId: session?.session?.id ?? null,
    targetLanguageCode: formalOutput.targetLanguageCode ?? null,
    targetLanguageLabel: targetLanguageLabelFor(formalOutput.targetLanguageCode),
    status: 'completed',
    translatedText: formalOutput.translatedText,
    version: formalOutput.version ?? null,
    source: 'formal',
    items: [],
    provider: null,
    model: null,
    providerMetadataAvailable: false,
    createdAt: formalOutput.createdAt ?? formalOutput.completedAt ?? null,
    completedAt: formalOutput.completedAt ?? formalOutput.createdAt ?? null,
    legacy: false
  };

  session.translationOutputs = [
    selectedTranslationOutput,
    ...(Array.isArray(session.translationOutputs) ? session.translationOutputs : [])
  ];
  session.selectedTranslationOutput = selectedTranslationOutput;
  session.readingContent = {
    ...(session.readingContent || {}),
    translationArticle: {
      kind: 'translationArticle',
      status: 'available',
      targetLanguageCode: selectedTranslationOutput.targetLanguageCode,
      targetLanguageLabel: selectedTranslationOutput.targetLanguageLabel,
      version: selectedTranslationOutput.version,
      text: formalOutput.translatedText,
      paragraphs: paragraphsForArticleText(formalOutput.translatedText),
      createdAt: selectedTranslationOutput.createdAt,
      completedAt: selectedTranslationOutput.completedAt,
      emptyReason: null
    }
  };
}

function paragraphsForArticleText(text) {
  return String(text)
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function targetLanguageLabelFor(code) {
  return SUPPORTED_LANGUAGES.find((language) => language.code === code)?.label || null;
}

function parseSessionTranslationHistoryPath(url) {
  const parsed = new URL(url, 'http://localhost');
  const prefix = '/api/sessions/';
  const suffix = '/translations';
  const encodedSessionId = parsed.pathname.slice(prefix.length, -suffix.length);
  if (!encodedSessionId) throw createHttpError('invalid_request');
  let sessionId;
  try { sessionId = decodeURIComponent(encodedSessionId); } catch { throw createHttpError('invalid_request'); }
  const targetLanguageCode = parsed.searchParams.get('targetLanguageCode');
  if (targetLanguageCode === null) return { sessionId, targetLanguageCode: undefined };
  if (targetLanguageCode.trim().length === 0) throw createHttpError('invalid_request');
  return { sessionId, targetLanguageCode };
}

function parseSessionTranslationOutputPath(path) {
  const prefix = '/api/sessions/';
  const separator = '/translations/';
  const separatorIndex = path.indexOf(separator, prefix.length);

  if (separatorIndex === -1) throw createHttpError('invalid_request');

  const encodedSessionId = path.slice(prefix.length, separatorIndex);
  const encodedOutputId = path.slice(separatorIndex + separator.length);

  if (!encodedSessionId || !encodedOutputId || encodedOutputId.includes('/')) throw createHttpError('invalid_request');

  try {
    const sessionId = decodeURIComponent(encodedSessionId);
    const outputId = decodeURIComponent(encodedOutputId);
    if (!sessionId.trim() || !outputId.trim()) throw createHttpError('invalid_request');
    return { sessionId, outputId };
  } catch (error) {
    if (error?.code === 'invalid_request') throw error;
    throw createHttpError('invalid_request');
  }
}

function isDeletableRetranslationOutput(output, sessionId) {
  return Boolean(
    output &&
      output.sessionId === sessionId &&
      typeof output.requestId === 'string' &&
      Number.isInteger(output.version) &&
      !String(output.id).startsWith('live-output:')
  );
}

function savedTranscriptRetranslationErrorCodeFor(error) {
  if (typeof error.message === 'string' && error.message.startsWith('Session record not found:')) {
    return 'session_not_found';
  }

  return errorCodeFor(error);
}

function extractSavedTranscriptRetranslationSessionId(path) {
  const prefix = '/api/saved-transcripts/';
  const suffix = '/translations';
  const encodedSessionId = path.slice(prefix.length, -suffix.length);

  try {
    return decodeURIComponent(encodedSessionId);
  } catch {
    throw createHttpError('invalid_request');
  }
}

function validateSavedTranscriptRetranslationRequest({ sessionId, body }) {
  const validatedSessionId = validateRequiredString(sessionId);

  if (!isPlainRequestObject(body)) {
    throw createHttpError('invalid_request');
  }

  return {
    sessionId: validatedSessionId,
    sourceLanguageCode: validateRequiredString(body.sourceLanguageCode),
    targetLanguageCode: validateSupportedTargetLanguageCode(body.targetLanguageCode),
    providerKey: body.providerKey
  };
}

function validateSupportedTargetLanguageCode(value) {
  validateRequiredString(value);

  if (!isSupportedLanguage(value)) {
    throw createHttpError('unsupported_language');
  }

  return value;
}

function validateRequiredString(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createHttpError('invalid_request');
  }

  return value;
}

function isPlainRequestObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function handleTranslationCommand(method, path, body, translationCommandController) {
  if (method === 'POST' && path === '/api/translation-requests') {
    return {
      status: 201,
      result: translationCommandController.createTranslationRequest({
        ...body,
        targetLanguageCode: validateSupportedTargetLanguageCode(body.targetLanguageCode)
      })
    };
  }

  if (method === 'POST' && path === '/api/translation-executions') {
    return {
      status: 202,
      result: translationCommandController.createTranslationExecution(body)
    };
  }

  if (
    method === 'PATCH' &&
    path.startsWith('/api/translation-executions/') &&
    path.length > '/api/translation-executions/'.length
  ) {
    const executionId = decodeURIComponent(path.slice('/api/translation-executions/'.length));
    return {
      status: 200,
      result: translationCommandController.updateTranslationExecution({
        ...body,
        id: executionId,
        executionId
      })
    };
  }

  if (method === 'POST' && path === '/api/translation-outputs') {
    return {
      status: 201,
      result: translationCommandController.createTranslationOutput({
        ...body,
        targetLanguageCode: validateSupportedTargetLanguageCode(body.targetLanguageCode)
      })
    };
  }

  throw createHttpError('not_found');
}

function handleExecutionControlCommand(method, path, executionControlController) {
  const operation = path.endsWith('/cancel') ? 'cancel' : 'retry';
  const executionId = extractExecutionControlExecutionId(path, operation);
  return operation === 'cancel'
    ? { status: 200, result: executionControlController.cancelExecution({ executionId }) }
    : { status: 202, result: executionControlController.retryExecution({ executionId }) };
}

function extractExecutionControlExecutionId(path, operation) {
  const prefix = '/api/translation-executions/';
  const suffix = `/${operation}`;
  const encodedExecutionId = path.slice(prefix.length, -suffix.length);
  try {
    return validateRequiredString(decodeURIComponent(encodedExecutionId));
  } catch (error) {
    if (error?.code === 'invalid_request') throw error;
    throw createHttpError('invalid_request');
  }
}

function extractDeadLetterExecutionId(path) {
  const prefix = '/api/translation-dead-letter-queue/';
  const suffix = '/replay';
  const encodedExecutionId = path.slice(prefix.length, -suffix.length);
  try {
    return validateRequiredString(decodeURIComponent(encodedExecutionId));
  } catch (error) {
    if (error?.code === 'invalid_request') throw error;
    throw createHttpError('invalid_request');
  }
}

function serializeDeadLetterReplayResponse(result) {
  return {
    sourceExecutionId: result.sourceExecutionId,
    execution: {
      id: result.execution.id,
      status: result.execution.status,
      translationRequestId: result.execution.translationRequestId
    }
  };
}

function serializeExecutionControlResponse(execution) {
  return {
    id: execution.id,
    translationRequestId: execution.translationRequestId,
    requestId: execution.translationRequestId,
    status: execution.status,
    ...(execution.providerKey === undefined ? {} : { providerKey: execution.providerKey }),
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    failureInfo: execution.failureInfo
  };
}

async function serveProductionStatic(req, res, requestPath) {
  const filePath = resolveStaticPath(requestPath);
  const staticPath = filePath && await existingFilePath(filePath);
  const responsePath = staticPath || INDEX_HTML_PATH;

  try {
    const body = await readFile(responsePath);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(responsePath),
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logEvent({
        level: 'error',
        event: 'static_file_error',
        path: requestPath,
        errorName: error?.name || 'Error',
        safeSummary: 'Production static file serving failed'
      });
    }
    return false;
  }
}

function resolveStaticPath(requestPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  const relativePath = normalize(decodedPath).replace(/^[/\\]+/, '');
  const filePath = resolve(DIST_DIR, relativePath || 'index.html');
  if (filePath !== DIST_DIR && !filePath.startsWith(`${DIST_DIR}${sep}`)) {
    return null;
  }

  return filePath;
}

async function existingFilePath(filePath) {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? filePath : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

function contentTypeFor(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ico':
      return 'image/x-icon';
    case '.webp':
      return 'image/webp';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function isSessionShareCollectionPath(path) {
  return path.startsWith('/api/sessions/') && path.endsWith('/shares') && path.split('/').length === 5;
}

function isSharedSessionCodeDetailPath(path) {
  return path.startsWith('/api/shared-sessions/code/') && !path.endsWith('/events') && path.split('/').length === 5;
}

function isSharedSessionCodeEventsPath(path) {
  return path.startsWith('/api/shared-sessions/code/') && path.endsWith('/events') && path.split('/').length === 6;
}

function isSessionSharePath(path) {
  return path.startsWith('/api/sessions/') && path.includes('/shares/') && path.split('/').length === 6;
}

function isSharedSessionDetailPath(path) {
  return path.startsWith('/api/shared-sessions/') && !path.endsWith('/events') && path.split('/').length === 4;
}

function isSharedSessionEventsPath(path) {
  return path.startsWith('/api/shared-sessions/') && path.endsWith('/events') && path.split('/').length === 5;
}

function isSharedMeetingDetailPath(path) {
  return path.startsWith('/api/shared-meetings/') && !path.endsWith('/start') &&
    !path.endsWith('/events') && !path.endsWith('/realtime-token') &&
    (path.split('/').length === 4 || path.split('/').length === 5);
}

function isSharedMeetingEventsPath(path) {
  return path.startsWith('/api/shared-meetings/') && path.endsWith('/events') &&
    (path.split('/').length === 5 || path.split('/').length === 6);
}

function isSharedMeetingRealtimeTokenPath(path) {
  return path.startsWith('/api/shared-meetings/') && path.endsWith('/realtime-token') &&
    (path.split('/').length === 5 || path.split('/').length === 6);
}

function isSharedMeetingTelemetryPath(path) {
  return path.startsWith('/api/shared-meetings/') && path.endsWith('/events/telemetry') &&
    (path.split('/').length === 6 || path.split('/').length === 7);
}

function isSharedMeetingStartPath(path) {
  return path.startsWith('/api/shared-meetings/') && path.endsWith('/start') &&
    (path.split('/').length === 4 || path.split('/').length === 5);
}

async function assertMeetingShareMutable(meetingId, meetingRepository) {
  if (!meetingRepository || typeof meetingRepository.getMeeting !== 'function') return;
  const meeting = await meetingRepository.getMeeting(meetingId);
  if (meeting?.status === 'completed') throw createHttpError('meeting_share_locked');
}

async function assertMeetingShareRevocable(meetingId, shareId, meetingRepository, sessionShareService) {
  if (!meetingRepository || typeof meetingRepository.getMeeting !== 'function') return;
  const meeting = await meetingRepository.getMeeting(meetingId);
  if (meeting?.status !== 'completed') return;
  const shares = typeof sessionShareService?.listShares === 'function'
    ? await sessionShareService.listShares(meetingId)
    : [];
  const share = shares.find((item) => item.id === shareId);
  if (share?.role !== 'viewer') throw createHttpError('meeting_share_locked');
}

async function resolveSharedMeeting(path, sessionShareService) {
  const raw = path.slice('/api/shared-meetings/'.length).replace(/\/(?:start|events|realtime-token|events\/telemetry)$/, '');
  if (raw.startsWith('code/')) return sessionShareService.resolveCode(decodeURIComponent(raw.slice('code/'.length)));
  return sessionShareService.resolveShare(decodeURIComponent(raw));
}

function decodeSessionPath(path, prefix, suffix) {
  const value = path.slice(prefix.length, -suffix.length);
  const sessionId = decodeURIComponent(value);
  if (!sessionId.trim()) throw createHttpError('invalid_request');
  return sessionId;
}

function parseSessionSharePath(path) {
  const match = path.match(/^\/api\/sessions\/([^/]+)\/shares\/([^/]+)$/);
  if (!match) throw createHttpError('invalid_request');
  return {
    sessionId: decodeURIComponent(match[1]),
    shareId: decodeURIComponent(match[2])
  };
}

function writeSseEvent(res, { id, type, data }) {
  res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function openSharedSessionEvents(res, req, share, sessionEventBroadcaster) {
  const snapshot = sessionEventBroadcaster.snapshot(share.sessionId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(res.__validatedOrigin ? { 'Access-Control-Allow-Origin': res.__validatedOrigin } : {}),
    'X-Content-Type-Options': 'nosniff'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (snapshot) {
    writeSseEvent(res, { id: snapshot.sequence, type: 'session.snapshot', data: publicViewerDetail(snapshot.payload) });
  } else {
    res.write(': keep-alive\n\n');
  }
  const unsubscribe = sessionEventBroadcaster.subscribe(share.sessionId, (event) => {
    writeSseEvent(res, { id: event.id, type: event.type, data: publicViewerDetail(event.data) });
  });
  req.on('close', unsubscribe);
}

function openSharedMeetingEvents(res, req, share, meetingEventBroadcaster, meetingReadController, afterEventId = 0) {
  const replay = meetingEventBroadcaster.eventsSince(share.meetingId, afterEventId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(res.__validatedOrigin ? { 'Access-Control-Allow-Origin': res.__validatedOrigin } : {}),
    'X-Content-Type-Options': 'nosniff'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (replay.gap) {
    writeSseEvent(res, { id: replay.cursor.eventId, type: 'meeting.gap', data: { meetingId: share.meetingId, cursor: replay.cursor } });
  }
  for (const event of replay.events) writeSseEvent(res, { id: event.eventId, type: event.type, data: publicMeetingCueEvent(event) });
  if (replay.events.length === 0 && !replay.gap) res.write(': keep-alive\n\n');
  const unsubscribe = meetingEventBroadcaster.subscribe(share.meetingId, (event) => {
    writeSseEvent(res, { id: event.eventId, type: event.type, data: publicMeetingCueEvent(event) });
  });
  req.on('close', unsubscribe);
}

function parseAfterEventId(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const queryValue = url.searchParams.get('after');
  const headerValue = req.headers?.['last-event-id'];
  const parsed = Number.parseInt(queryValue || headerValue || '0', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseViewerPageOptions(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const limitValue = url.searchParams.get('limit');
  return {
    before: url.searchParams.get('before') || null,
    ...(limitValue === null ? {} : { limit: Number(limitValue) })
  };
}

function normalizePublishedCue(value, { meetingId, segmentId, sessionId }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw createHttpError('subtitle_cue_invalid');
  const cue = {
    cueId: value.cueId,
    sessionId,
    segmentId,
    sequence: value.sequence,
    startTimeMs: value.startTimeMs,
    endTimeMs: value.endTimeMs,
    sourceLanguageCode: value.sourceLanguageCode || null,
    targetLanguageCode: value.targetLanguageCode || null,
    sourceText: value.sourceText ?? '',
    translatedText: value.translatedText ?? '',
    sourceStatus: value.sourceStatus || (value.sourceText ? 'finalized' : 'pending'),
    translationStatus: value.translationStatus || (value.translatedText ? 'finalized' : 'pending'),
    sourceVersion: Number.isInteger(value.sourceVersion) ? value.sourceVersion : (value.sourceText ? 1 : 0),
    translationVersion: Number.isInteger(value.translationVersion) ? value.translationVersion : (value.translatedText ? 1 : 0),
    ...(value.rawSource !== undefined ? { rawSource: value.rawSource } : {}),
    ...(value.rawTranslation !== undefined ? { rawTranslation: value.rawTranslation } : {}),
    ...(value.initialTranslation !== undefined ? { initialTranslation: value.initialTranslation } : {}),
    status: value.status,
    finalizedReason: value.finalizedReason || null,
    ...(value.refinement ? { refinement: value.refinement } : {})
  };
  if (typeof cue.cueId !== 'string' || !cue.cueId || cue.status !== 'final' ||
      !Number.isInteger(cue.sequence) || cue.sequence < 1 ||
      !Number.isFinite(cue.startTimeMs) || cue.startTimeMs < 0 ||
      (cue.endTimeMs !== null && cue.endTimeMs !== undefined && (!Number.isFinite(cue.endTimeMs) || cue.endTimeMs < cue.startTimeMs)) ||
      typeof cue.sourceText !== 'string' || typeof cue.translatedText !== 'string' ||
      (!cue.sourceText.trim() && !cue.translatedText.trim()) ||
      !['pending', 'finalized', 'unavailable'].includes(cue.sourceStatus) ||
      !['pending', 'finalized', 'unavailable'].includes(cue.translationStatus) ||
      !Number.isInteger(cue.sourceVersion) || cue.sourceVersion < 0 ||
      !Number.isInteger(cue.translationVersion) || cue.translationVersion < 0) {
    throw createHttpError('subtitle_cue_invalid');
  }
  return { ...cue, meetingId };
}

function publicMeetingCueEvent(event) {
  return {
    eventId: event.eventId,
    eventType: event.eventType || event.type,
    type: event.type,
    meetingId: event.meetingId,
    segmentId: event.segmentId,
    cueId: event.cueId || event.cue?.cueId,
    cueSequence: event.cueSequence || event.cue?.sequence,
    occurredAt: event.occurredAt || null,
    committedAt: event.committedAt || (event.occurredAt ? Date.parse(event.occurredAt) : null),
    cue: event.cue,
    timing: event.timing
  };
}

function publicViewerDetail(detail) {
  const clone = detail?.sessionRecord
    ? mapSessionRecordDetailToDTO(detail)
    : JSON.parse(JSON.stringify(detail));
  if (clone?.session) {
    delete clone.session.audioArtifacts;
    delete clone.session.selectedInputDeviceId;
    delete clone.session.inputDeviceLabelSnapshot;
  }
  return clone;
}

function publicMeetingViewerDetail(detail) {
  const clone = JSON.parse(JSON.stringify(detail || {}));
  if (clone.meeting) {
    delete clone.meeting.glossaryEntries;
    delete clone.meeting.privateGlossaryEntries;
  }
  delete clone.audioArtifacts;
  if (Array.isArray(clone.segments)) {
    clone.segments = clone.segments.map((segment) => {
      const safeSegment = { ...segment };
      delete safeSegment.liveSessionId;
      if (safeSegment.settingsSnapshot) {
        safeSegment.settingsSnapshot = { ...safeSegment.settingsSnapshot };
        delete safeSegment.settingsSnapshot.glossaryEntries;
        delete safeSegment.settingsSnapshot.privateGlossaryEntries;
      }
      return safeSegment;
    });
  }
  if (Array.isArray(clone.timeline)) {
    clone.timeline = clone.timeline.map((segment) => {
      const safeSegment = { ...segment };
      delete safeSegment.liveSessionId;
      if (safeSegment.settingsSnapshot) {
        safeSegment.settingsSnapshot = { ...safeSegment.settingsSnapshot };
        delete safeSegment.settingsSnapshot.glossaryEntries;
        delete safeSegment.settingsSnapshot.privateGlossaryEntries;
      }
      return safeSegment;
    });
  }
  return clone;
}

if (IS_MAIN) {
  const defaultApplicationDependencies = getDefaultApplicationDependencies();
  await ensureDataDirectory();
  const server = http.createServer(handleRequest);
  attachExecutionEventsWebSocket({
    server,
    accessControl: globalAccessControl,
    sessionReadController: defaultApplicationDependencies.sessionReadController,
    broadcaster: defaultApplicationDependencies.executionEventBroadcaster,
    WebSocketServerClass: WebSocketServer
  });
  const stopTranslationExecutionWorkerRuntime = startTranslationExecutionWorkerRuntime();

  server.listen(SERVER_PORT, SERVER_HOST, () => {
    structuredLogger.log({ event: 'server_started', safeSummary: `Live Translate API listening on ${SERVER_HOST}:${SERVER_PORT}` });
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stopTranslationExecutionWorkerRuntime();
      server.close(() => {
        process.exit(0);
      });
    });
  }
}
