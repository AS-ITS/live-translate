import { mergePolishedItemsFromOutputs } from './transcriptPolishing.js';

export function compactTranslationHistoryForDetail(detail) {
  const history = detail?.translationHistory || {};
  return {
    outputs: Array.isArray(history.outputs) ? history.outputs : [],
    executions: Array.isArray(history.executions) ? history.executions : []
  };
}

export function retryLineagesForExecutions(executions = []) {
  const lineages = new Map();
  for (const execution of Array.isArray(executions) ? executions : []) {
    if (!execution || typeof execution !== 'object') continue;
    const requestId = execution.requestId || execution.translationRequestId || null;
    const key = requestId || `execution:${execution.id || lineages.size}`;
    if (!lineages.has(key)) {
      lineages.set(key, { requestId, executions: [] });
    }
    lineages.get(key).executions.push(execution);
  }

  return [...lineages.values()].map((lineage) => ({
    ...lineage,
    executions: [...lineage.executions].sort(compareExecutionTimeline)
  }));
}

export function mergeRetranslationHistoryIntoDetail(detail, translations) {
  if (!detail) return detail;

  const detailHistory = compactTranslationHistoryForDetail(detail);
  const translationsHistory = compactTranslationHistoryForDetail(translations);
  const hasAuthoritativeTranslationHistory = Boolean(
    translations && typeof translations === 'object' && (
      (translations.translationHistory && typeof translations.translationHistory === 'object') ||
      Array.isArray(translations.outputs) ||
      Array.isArray(translations.executions)
    )
  );
  if (!hasAuthoritativeTranslationHistory) return detail;

  const mergedOutputs = mergeHistoryItemsById(detailHistory.outputs, translationsHistory.outputs);
  const polishedItems = mergePolishedItemsFromOutputs(mergedOutputs);
  return {
    ...detail,
    polishedArticle: polishedArticleContentFromItems(polishedItems, mergedOutputs),
    translationHistory: {
      outputs: mergedOutputs,
      executions: translationsHistory.executions
    }
  };
}

export function removeRetranslationOutputFromDetail(detail, outputId) {
  if (!detail) return detail;

  const history = compactTranslationHistoryForDetail(detail);
  const outputs = history.outputs.filter((output) => output.id !== outputId);
  const polishedItems = mergePolishedItemsFromOutputs(outputs);
  return {
    ...detail,
    polishedArticle: polishedArticleContentFromItems(polishedItems, outputs),
    translationHistory: {
      outputs,
      executions: history.executions
    }
  };
}

function polishedArticleContentFromItems(items = [], outputs = []) {
  const latest = [...(Array.isArray(outputs) ? outputs : [])].sort((left, right) => (
    (right?.version ?? 0) - (left?.version ?? 0)
    || String(right?.completedAt || '').localeCompare(String(left?.completedAt || ''))
  ))[0];
  const text = items.map((item) => item.polishedText).filter(Boolean).join('\n');
  return {
    kind: 'polishedArticle',
    status: text ? 'available' : 'empty',
    text,
    paragraphs: text ? text.split(/\n+/).filter(Boolean) : [],
    items,
    version: latest?.version ?? null,
    createdAt: latest?.createdAt ?? null,
    completedAt: latest?.completedAt ?? null,
    emptyReason: text ? null : 'no_content'
  };
}

function mergeHistoryItemsById(firstItems, secondItems) {
  const merged = new Map();
  for (const item of [...firstItems, ...secondItems]) {
    const key = item?.id || item?.executionId || item?.requestId;
    if (!key) continue;
    merged.set(key, item);
  }
  return [...merged.values()];
}

function compareExecutionTimeline(first, second) {
  const firstTime = first?.createdAt || first?.startedAt || first?.providerAttemptedAt || '';
  const secondTime = second?.createdAt || second?.startedAt || second?.providerAttemptedAt || '';
  return String(firstTime).localeCompare(String(secondTime)) || String(first?.id || '').localeCompare(String(second?.id || ''));
}
