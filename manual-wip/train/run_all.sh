#!/usr/bin/env bash
set -e
T=$(cd "$(dirname "$0")" && pwd)
timeout 300 $T/setup.sh > /tmp/train-run.log 2>&1; tail -1 /tmp/train-run.log
for s in "$@"; do python3 $T/$s; done
