export function createPublicRuntimeConfig(env = process.env) {
  return Object.freeze({
    livePipelineTraceEnabled: env?.LIVE_PIPELINE_TRACE_ENABLED === 'true'
  });
}
