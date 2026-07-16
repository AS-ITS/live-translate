const DISPATCH_SUCCESS_RESULT = Object.freeze({
  status: 'dispatched'
});

export function createFakeTranslationExecutionDispatcher() {
  const dispatchedExecutions = [];

  return Object.freeze({
    async dispatch(execution) {
      dispatchedExecutions.push(execution);
      return DISPATCH_SUCCESS_RESULT;
    },

    get dispatchedExecutions() {
      return [...dispatchedExecutions];
    }
  });
}
