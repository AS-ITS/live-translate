export function mapTranslationRequestToDTO(request = {}) {
  return {
    id: request.id,
    sourceText: sourceTextFor(request.sourceTranscriptSnapshot),
    targetLanguageCode: request.targetLanguageCode,
    ...(request.operation === 'transcript_polishing' ? polishingRequestFields(request) : {}),
    createdAt: request.createdAt
  };
}

export function mapTranslationExecutionToDTO(execution = {}, request = {}) {
  return {
    id: execution.id,
    translationRequestId: execution.translationRequestId,
    ...(request.operation === 'transcript_polishing' ? { operation: request.operation } : {}),
    status: execution.status,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    failureInfo: safeFailureInfo(execution.failureInfo)
  };
}

export function mapTranslationOutputToSummaryDTO(output = {}) {
  return {
    id: output.id,
    executionId: output.executionId,
    translatedText: output.translatedText,
    targetLanguageCode: output.targetLanguageCode,
    ...(output.operation === 'transcript_polishing' ? polishingFields(output, { includeProviderModel: true }) : {}),
    createdAt: output.createdAt
  };
}

export function mapTranslationOutputToDetailDTO(output = {}) {
  return {
    ...mapTranslationOutputToSummaryDTO(output),
    requestId: output.requestId,
    version: output.version ?? null,
    source: output.version === undefined ? 'legacy' : 'formal',
    sourceLanguageCode: output.sourceLanguageCode ?? null,
    completedAt: output.completedAt ?? output.createdAt
  };
}

export function mapTranslationExecutionHistoryDTO(execution = {}, request = {}) {
  return {
    id: execution.id,
    requestId: request.id,
    targetLanguageCode: request.targetLanguageCode,
    ...(request.operation === 'transcript_polishing' ? { operation: request.operation } : {}),
    status: execution.status,
    startedAt: execution.startedAt ?? null,
    createdAt: request.createdAt ?? null,
    providerAttemptStatus: execution.providerAttemptStatus ?? null,
    providerAttemptedAt: execution.providerAttemptedAt ?? null,
    providerCompletedAt: execution.providerCompletedAt ?? null,
    failureInfo: safeFailureInfo(execution.failureInfo),
    ...(execution.completedAt === null ? {} : { completedAt: execution.completedAt })
  };
}

export function compareTranslationOutputDetails(first, second) {
  const completed = String(second.completedAt).localeCompare(String(first.completedAt));
  return completed || String(first.id).localeCompare(String(second.id));
}

function polishingFields(value, { includeProviderModel = false } = {}) {
  return {
    operation: value.operation,
    polishedItems: value.polishedItems ?? [],
    ...(value.refinedItems === undefined ? {} : { refinedItems: value.refinedItems }),
    ...(value.refinedCues === undefined ? {} : { refinedCues: value.refinedCues }),
    ...(value.refinementTargets === undefined ? {} : { refinementTargets: value.refinementTargets }),
    ...(value.refinedSource === undefined ? {} : { refinedSource: value.refinedSource }),
    ...(value.refinedTranslation === undefined ? {} : { refinedTranslation: value.refinedTranslation }),
    segmentRange: value.segmentRange ?? null,
    inputHash: value.inputHash ?? null,
    model: includeProviderModel ? value.model ?? value.providerMetadata?.model ?? null : value.model ?? null
  };
}

function polishingRequestFields(value) {
  return {
    operation: value.operation,
    segmentRange: value.segmentRange ?? null,
    inputHash: value.inputHash ?? null,
    model: value.model ?? null
  };
}

function sourceTextFor(snapshot = {}) {
  if (typeof snapshot?.sourceText === 'string') return snapshot.sourceText;
  if (typeof snapshot?.text === 'string') return snapshot.text;
  return Array.isArray(snapshot?.items)
    ? snapshot.items.map((item) => item?.text).filter((text) => typeof text === 'string' && text.length > 0).join('\n')
    : null;
}

export function safeFailureInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['reason', 'category', 'code', 'providerCode', 'errorName', 'message', 'providerStatus', 'providerMessage', 'model']) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  if (typeof value.providerCode === 'number') result.providerCode = value.providerCode;
  if (Number.isInteger(value.status)) result.status = value.status;
  if (value.requestConfig && typeof value.requestConfig === 'object') {
    result.requestConfig = { fields: Array.isArray(value.requestConfig.fields) ? value.requestConfig.fields.slice(0, 20) : [] };
  }
  return Object.keys(result).length ? result : null;
}
