#!/usr/bin/env bash
# Start JUEGO locally at http://127.0.0.1:8000
# First run downloads data, builds the database and trains the models.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi

if [ ! -f data/juego.duckdb ] || [ "${1:-}" = "--rebuild" ]; then
  (cd pipeline && ../.venv/bin/python fetch.py && ../.venv/bin/python build.py && ../.venv/bin/python train.py)
fi

# Bound to localhost only; access log off so search terms in URLs aren't written anywhere.
export FASTAPI_OTEL_AUTO_CONFIGURE=false
exec .venv/bin/uvicorn app:app --app-dir backend --host 127.0.0.1 --port "${PORT:-8000}" --no-access-log
