#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"

if ! command -v vercel >/dev/null 2>&1; then
  echo "Vercel CLI is required. Install it with: npm install --global vercel" >&2
  exit 1
fi

if [[ ! -f "$project_root/.vercel/project.json" ]]; then
  echo "Vercel project is not linked for this repository." >&2
  echo "Run 'vercel link' from $project_root, then retry." >&2
  exit 1
fi

if ! vercel whoami >/dev/null 2>&1; then
  echo "Vercel login is required. Run 'vercel login', then retry." >&2
  exit 1
fi

cd "$project_root"

echo "Deploying Preview..."
if ! deployment_output="$(vercel deploy --yes 2>&1)"; then
  printf '%s\n' "$deployment_output" >&2
  exit 1
fi
printf '%s\n' "$deployment_output"

preview_url="$(printf '%s\n' "$deployment_output" | rg -o 'https://[^[:space:]]+' | rg -v 'vercel.com|github.com' | tail -n 1 || true)"
preview_url="${preview_url%%[\",]*}"
if [[ -z "$preview_url" ]]; then
  echo "Preview deployment succeeded, but its URL could not be detected." >&2
  exit 1
fi

echo "Running deployment preflight against $preview_url..."
if ! SMOKE_BASE_URL="$preview_url" npm run test:deployment-preflight; then
  echo "Preview deployed, but deployment preflight failed: $preview_url" >&2
  exit 1
fi

echo "Preview deployment passed: $preview_url"
