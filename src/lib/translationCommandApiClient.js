const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json'
});

export function createTranslationCommandApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('translation command API client requires fetchImpl to be a function.');
  }

  return Object.freeze({
    createTranslationRequest(command) {
      return requestJson(fetchImpl, '/api/translation-requests', 'POST', command);
    },

    createTranslationExecution(command) {
      return requestJson(fetchImpl, '/api/translation-executions', 'POST', command);
    },

    async updateTranslationExecution(executionId, command) {
      const normalizedExecutionId = validateExecutionId(executionId);

      return requestJson(
        fetchImpl,
        `/api/translation-executions/${encodeURIComponent(normalizedExecutionId)}`,
        'PATCH',
        command
      );
    },

    async cancelTranslationExecution(executionId) {
      return requestEmptyJson(fetchImpl, executionControlUrl(executionId, 'cancel'));
    },

    async retryFailedTranslationExecution(executionId) {
      return requestEmptyJson(fetchImpl, executionControlUrl(executionId, 'retry'));
    },

    createTranslationOutput(command) {
      return requestJson(fetchImpl, '/api/translation-outputs', 'POST', command);
    }
  });
}

function executionControlUrl(executionId, operation) {
  const normalizedExecutionId = validateExecutionId(executionId);
  return `/api/translation-executions/${encodeURIComponent(normalizedExecutionId)}/${operation}`;
}

async function requestJson(fetchImpl, url, method, command) {
  const response = await fetchImpl(url, {
    method,
    headers: JSON_HEADERS,
    body: JSON.stringify(command)
  });

  if (!isSuccessResponse(response)) {
    await rejectHttpError(response);
  }

  return response.json();
}

async function requestEmptyJson(fetchImpl, url) {
  const response = await fetchImpl(url, { method: 'POST' });

  if (!isSuccessResponse(response)) {
    await rejectHttpError(response);
  }

  return response.json();
}

function isSuccessResponse(response) {
  return response && response.status >= 200 && response.status < 300;
}

async function rejectHttpError(response) {
  const status = response?.status;
  const error = new Error(`Translation command API request failed with HTTP ${status}.`);
  error.status = status;

  if (typeof response?.json === 'function') {
    try {
      error.body = await response.json();
    } catch {
      // Preserve the HTTP failure even when the error body is not valid JSON.
    }
  }

  if (typeof error.body?.error?.code === 'string') {
    error.code = error.body.error.code;
  }

  if (typeof error.body?.error?.message === 'string') {
    error.safeMessage = error.body.error.message;
  }

  throw error;
}

function validateExecutionId(executionId) {
  if (typeof executionId !== 'string' || executionId.trim() === '') {
    throw new TypeError('executionId must be a non-empty string.');
  }

  return executionId;
}
