#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
mkdir -p cache
chmod 700 cache
bun_bin="${BUN_BIN:-$(command -v bun || true)}"
if [[ -z "$bun_bin" && -x "$HOME/.bun/bin/bun" ]]; then
  bun_bin="$HOME/.bun/bin/bun"
fi
if [[ -z "$bun_bin" ]]; then
  echo "Bun не найден. Установите Bun или задайте BUN_BIN." >&2
  exit 1
fi
exec flock -n -E 75 cache/run.lock "$bun_bin" --env-file=.env src/index.js "$@"
