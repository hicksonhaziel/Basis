#!/bin/sh
set -eu

if [ ! -d /data ] || [ -L /data ]; then
  echo 'fatal: /data must exist as a real directory' >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo 'fatal: volume initialization requires root' >&2
  exit 1
fi

chown -R node:node -- /data
exec gosu node "$@"
