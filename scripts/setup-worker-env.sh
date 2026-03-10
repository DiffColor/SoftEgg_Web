#!/usr/bin/env bash

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUTPUT_FILE="$ROOT_DIR/.dev.vars"
TMP_FILE="$OUTPUT_FILE.tmp"

require_env() {
  key="$1"
  value="${!key-}"
  if [ -z "$value" ]; then
    printf '%s\n' "$key 환경변수가 필요합니다." >&2
    exit 1
  fi
  case "$value" in
    *$'\n'*|*$'\r'*)
      printf '%s\n' "$key 값에는 줄바꿈 문자를 넣을 수 없습니다." >&2
      exit 1
      ;;
  esac
}

require_env "SOFTEGG_API_BASE_URL"
require_env "SOFTEGG_FTP_HOST"
require_env "SOFTEGG_FTP_USER"
require_env "SOFTEGG_FTP_PASSWORD"

umask 077
{
  printf 'SOFTEGG_API_BASE_URL=%s\n' "$SOFTEGG_API_BASE_URL"
  printf 'SOFTEGG_FTP_HOST=%s\n' "$SOFTEGG_FTP_HOST"
  printf 'SOFTEGG_FTP_USER=%s\n' "$SOFTEGG_FTP_USER"
  printf 'SOFTEGG_FTP_PASSWORD=%s\n' "$SOFTEGG_FTP_PASSWORD"
} > "$TMP_FILE"
mv "$TMP_FILE" "$OUTPUT_FILE"

printf '%s\n' ".dev.vars 파일을 갱신했습니다: $OUTPUT_FILE"
