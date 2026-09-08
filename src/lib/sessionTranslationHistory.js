import { mergePolishedItemsFromOutputs } from './transcriptPolishing.js';

export function compactTranslationHistoryForDetail(detail) {
  const history = detail?.translationHistory || {};
  return {
    outputs: Array.isArray(history.outputs) ? history.outputs : [],
    executions: Array.isArray(history.executions) ? history.executions : []
  };
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
