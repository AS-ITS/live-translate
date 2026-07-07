# Release Checklist

Before releasing a production build:

- [ ] `GEMINI_API_KEY` is configured only in the backend environment.
- [ ] `DEMO_ACCESS_TOKEN` is a long random value and is not committed.
- [ ] `VITE_DEMO_ACCESS_TOKEN` matches `DEMO_ACCESS_TOKEN` for this demo build.
- [ ] `ALLOWED_ORIGIN` exactly matches the production frontend origin.
- [ ] `HOST` and `PORT` match the deployment platform.
- [ ] `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX` are set for expected traffic.
- [ ] `npm run test:unit` passes.
- [ ] `npm run test:integration` passes.
- [ ] `npm run test:e2e` passes.
- [ ] `npm run build` passes.
- [ ] `GET /healthz` returns 200 after deployment.
- [ ] `GET /readyz` returns 200 after deployment.
- [ ] Logs contain request ids and safe metadata only.
- [ ] Logs do not contain `GEMINI_API_KEY` or Gemini ephemeral token values.
- [ ] Live smoke testing is run only with explicit approval:

```bash
ENABLE_REAL_GEMINI_TEST=true GEMINI_API_KEY=your_real_key npm run test:live-smoke
```
