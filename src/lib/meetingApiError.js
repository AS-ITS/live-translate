const ERROR_MESSAGES = Object.freeze({
  auth_required: '登入狀態已失效，請重新登入。',
  auth_invalid: '登入狀態已失效，請重新登入。',
  auth_forbidden: '目前帳號沒有權限查看這場會議。',
  recorder_forbidden: '目前帳號沒有錄製這場會議的權限。',
  meeting_not_found: '找不到這場會議，請重新整理後再試。',
  meeting_read_unavailable: '雲端會議服務目前無法使用。',
  cloud_capability_unavailable: '雲端會議服務目前無法使用。',
  supabase_unavailable: '雲端會議服務目前無法使用。',
  supabase_schema_missing: '雲端會議服務目前無法使用，請確認資料庫 migration。',
  supabase_credentials_invalid: '雲端會議服務目前無法使用，請確認部署設定。',
  supabase_request_failed: '雲端會議服務目前無法使用。'
});

export function meetingApiErrorMessage(error, fallback = '會議操作失敗，請稍後再試。') {
  const status = Number(error?.status);
  const message = ERROR_MESSAGES[error?.code]
    || (status === 401 ? ERROR_MESSAGES.auth_invalid : null)
    || (status === 403 ? ERROR_MESSAGES.auth_forbidden : null)
    || (status === 404 ? ERROR_MESSAGES.meeting_not_found : null)
    || (status === 503 ? ERROR_MESSAGES.cloud_capability_unavailable : null)
    || error?.apiMessage
    || fallback;

  return error?.requestId ? `${message}（識別碼：${error.requestId}）` : message;
}
