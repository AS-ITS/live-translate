const REQUIRED_SERVER_VARIABLES = Object.freeze([
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_JWKS_URL',
  'AUTH_ALLOWED_EMAIL_DOMAINS'
]);

export function inspectCloudEnvironment({ env = process.env, requireBrowserConfig = false } = {}) {
  const issues = [];
  for (const name of REQUIRED_SERVER_VARIABLES) {
    if (!String(env[name] || '').trim()) issues.push({ code: `${name.toLowerCase()}_missing`, variable: name });
  }

  const supabaseUrl = parseUrl(env.SUPABASE_URL);
  const jwksUrl = parseUrl(env.SUPABASE_JWKS_URL);
  const browserUrl = parseUrl(env.VITE_SUPABASE_URL);

  if (env.SUPABASE_URL && !supabaseUrl) issues.push({ code: 'supabase_url_invalid', variable: 'SUPABASE_URL' });
  if (env.SUPABASE_JWKS_URL && !jwksUrl) issues.push({ code: 'supabase_jwks_url_invalid', variable: 'SUPABASE_JWKS_URL' });
  if (env.VITE_SUPABASE_URL && !browserUrl) issues.push({ code: 'vite_supabase_url_invalid', variable: 'VITE_SUPABASE_URL' });

  if (supabaseUrl && jwksUrl && (jwksUrl.origin !== supabaseUrl.origin || jwksUrl.pathname !== '/auth/v1/.well-known/jwks.json')) {
    issues.push({ code: 'supabase_jwks_project_mismatch', variable: 'SUPABASE_JWKS_URL' });
  }
  if (supabaseUrl && browserUrl && browserUrl.origin !== supabaseUrl.origin) {
    issues.push({ code: 'supabase_browser_project_mismatch', variable: 'VITE_SUPABASE_URL' });
  }
  if (requireBrowserConfig && !String(env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim()) {
    issues.push({ code: 'supabase_publishable_key_missing', variable: 'VITE_SUPABASE_PUBLISHABLE_KEY' });
  }

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    projectRef: supabaseUrl ? supabaseUrl.hostname.split('.')[0] || null : null
  });
}

export function cloudEnvironmentError({ env = process.env, requireBrowserConfig = false } = {}) {
  const status = inspectCloudEnvironment({ env, requireBrowserConfig });
  if (status.ok) return null;
  const error = new Error('Cloud environment configuration is invalid.');
  error.code = status.issues[0]?.code || 'cloud_environment_invalid';
  error.status = 503;
  error.details = status.issues.map(({ code, variable }) => ({ code, variable }));
  return error;
}

function parseUrl(value) {
  if (!String(value || '').trim()) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
