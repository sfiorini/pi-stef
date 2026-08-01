#!/usr/bin/env bash
set -euo pipefail

DEFAULT_API_BASE_URL="https://api.telegram.org"
DEFAULT_PARSE_MODE="HTML"
MAX_MESSAGE_LENGTH=4096

BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
CHAT_ID=${TELEGRAM_CHAT_ID:-}
API_BASE_URL=${TELEGRAM_API_BASE_URL:-$DEFAULT_API_BASE_URL}
PARSE_MODE=${TELEGRAM_PARSE_MODE:-$DEFAULT_PARSE_MODE}
MESSAGE=""
MESSAGE_FILE=""

usage() {
  cat <<'EOF'
Usage:
  notify-telegram.sh --message <text> [--bot-token <token>] [--chat-id <id>] [--api-base-url <url>]
  notify-telegram.sh --message-file <path> [--bot-token <token>] [--chat-id <id>] [--api-base-url <url>]

Environment fallbacks:
  TELEGRAM_BOT_TOKEN
  TELEGRAM_CHAT_ID
  TELEGRAM_API_BASE_URL
  TELEGRAM_PARSE_MODE
EOF
}

fail_usage() {
  echo "Error: $*" >&2
  usage >&2
  exit 2
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --bot-token)
        BOT_TOKEN=${2:-}
        shift 2
        ;;
      --chat-id)
        CHAT_ID=${2:-}
        shift 2
        ;;
      --api-base-url)
        API_BASE_URL=${2:-}
        shift 2
        ;;
      --message)
        MESSAGE=${2:-}
        shift 2
        ;;
      --message-file)
        MESSAGE_FILE=${2:-}
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail_usage "unknown argument: $1"
        ;;
    esac
  done

  if [[ -n "$MESSAGE" && -n "$MESSAGE_FILE" ]]; then
    fail_usage "use either --message or --message-file, not both"
  fi

  if [[ -n "$MESSAGE_FILE" ]]; then
    [[ -r "$MESSAGE_FILE" ]] || fail_usage "message file is not readable: $MESSAGE_FILE"
    MESSAGE=$(<"$MESSAGE_FILE")
  fi

  [[ -n "$MESSAGE" ]] || fail_usage "message is required"
  [[ -n "$BOT_TOKEN" ]] || fail_usage "bot token is required (use --bot-token or TELEGRAM_BOT_TOKEN)"
  [[ -n "$CHAT_ID" ]] || fail_usage "chat id is required (use --chat-id or TELEGRAM_CHAT_ID)"
  command -v curl >/dev/null 2>&1 || fail_usage "curl is required"

  if [[ ${#MESSAGE} -gt "$MAX_MESSAGE_LENGTH" ]]; then
    MESSAGE=${MESSAGE:0:$MAX_MESSAGE_LENGTH}
  fi
}

main() {
  parse_args "$@"

  curl -fsS -X POST \
    "${API_BASE_URL%/}/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${MESSAGE}" \
    --data-urlencode "parse_mode=${PARSE_MODE}" \
    --data-urlencode "disable_web_page_preview=true" \
    >/dev/null
}

main "$@"
