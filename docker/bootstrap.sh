#!/bin/sh
# Entrypoint of the n8n container in docker-compose.yml.
# First start only: create the two credentials from the environment, import the
# four workflows and publish them. Later starts leave your edits alone.
set -eu

MARK=/home/node/.n8n/.studio-bot-imported

if [ ! -f "$MARK" ]; then
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    echo "studio-bot: TELEGRAM_BOT_TOKEN is empty. Put the token from @BotFather in .env." >&2
    exit 1
  fi
  STAGE=$(mktemp -d)
  node /bootstrap/prepare.mjs /bootstrap/workflows "$STAGE"
  n8n import:credentials --input="$STAGE/credentials.json"
  n8n import:workflow --separate --input="$STAGE/workflows"
  for id in studioBotErrors01 studioBotCalendar studioBotNotify01 studioBotChat0001; do
    n8n publish:workflow --id="$id"
  done
  rm -rf "$STAGE"
  touch "$MARK"
  echo "studio-bot: workflows imported and published"
fi

exec n8n start
