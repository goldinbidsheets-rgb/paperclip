#!/usr/bin/env bash
# Shims record to a baked-in path: child input.env cannot drop the marker target.
make_download_guard() {
  local directory=$1 marker=$2
  mkdir -p "$directory"
  printf '#!/bin/sh\nprintf "%%s\\n" FORBIDDEN_NETWORK_TOOL >> %q\nexit 97\n' "$marker" > "$directory/curl"
  chmod +x "$directory/curl"
  cp "$directory/curl" "$directory/wget"
}
download_guard_status() {
  if test -s "$1"; then
    echo 'FORBIDDEN_NETWORK_TOOL: durable attempt marker detected' >&2
    return 97
  fi
}
