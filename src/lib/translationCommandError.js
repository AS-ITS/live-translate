const OPERATION_LABELS = Object.freeze({
  startTranslationExecution: '建立翻譯執行',
  createTranslationOutput: '儲存最終翻譯結果',
  completeTranslationExecution: '完成翻譯執行',
  failTranslationExecution: '標記翻譯執行失敗'
});

export function formatTranslationCommandPersistenceError(error, { operation } = {}) {
  const operationLabel = OPERATION_LABELS[operation] || '保存翻譯紀錄';
  const status = Number.isInteger(error?.status) ? `HTTP ${error.status}` : '';
  const code = typeof error?.code === 'string' && /^[a-z0-9_:-]+$/i.test(error.code)
    ? `錯誤代碼：${error.code}`
    : '';
  const details = [status, code].filter(Boolean).join('，');

  return `翻譯紀錄保存失敗：${operationLabel}${details ? `（${details}）` : ''}。即時翻譯仍可繼續。`;
}
