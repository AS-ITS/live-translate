#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
supabase_dir="$project_root/supabase"
linked_project_file="$supabase_dir/.temp/linked-project.json"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required. Install it from https://supabase.com/docs/guides/cli." >&2
  exit 1
fi

if [[ ! -f "$supabase_dir/config.toml" ]]; then
  echo "Supabase config was not found at $supabase_dir/config.toml." >&2
  exit 1
fi

if [[ ! -f "$linked_project_file" ]]; then
  echo "Supabase project is not linked for this repository." >&2
  echo "Run 'supabase link --project-ref <target-project-ref>' from $project_root, then retry." >&2
  exit 1
fi

linked_project_name="$(sed -n 's/.*"name":"\([^"]*\)".*/\1/p' "$linked_project_file")"
linked_project_ref="$(sed -n 's/.*"ref":"\([^"]*\)".*/\1/p' "$linked_project_file")"
echo "Applying Supabase migrations to ${linked_project_name:-linked project} (${linked_project_ref:-unknown ref})..."
echo "Warning: verify this linked project is the intended Preview or test environment before continuing." >&2

cd "$project_root"
supabase db push --linked
