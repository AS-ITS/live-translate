# Deployment

This project has a Vite frontend and a small Node HTTP backend that creates
Gemini Live ephemeral tokens.

## Required Environment

Backend:

```env
NODE_ENV=production
GEMINI_API_KEY=your_real_gemini_api_key
DEMO_ACCESS_TOKEN=long_random_shared_secret
HOST=0.0.0.0
PORT=3001
ALLOWED_ORIGIN=https://your-frontend.example.com
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=20
```

Frontend build:

```env
VITE_DEMO_ACCESS_TOKEN=long_random_shared_secret
```

`DEMO_ACCESS_TOKEN` and `VITE_DEMO_ACCESS_TOKEN` must match for the demo access
gate. Do not commit real values.

## Build

```bash
npm install
npm run build
```

## Start Backend

```bash
npm run start:production
```

The production start script binds to `HOST=0.0.0.0` by default. Override `HOST`
or `PORT` in the deployment environment when needed.

## Health Checks

- `GET /healthz`: process is running.
- `GET /readyz`: required production configuration is present.

## Security Notes

- Keep `GEMINI_API_KEY` server-side only.
- Do not log `GEMINI_API_KEY` or ephemeral Gemini tokens.
- Set `ALLOWED_ORIGIN` to the exact deployed frontend origin.
- Put TLS, request size limits, and any edge WAF/rate limits in front of the
  Node process when deploying publicly.
