#!/usr/bin/env bash
# Aggregate needed-job results into one pass/fail.
#
#   gate.sh changes=<result> <job>=<result> ...
#
# `changes` must have succeeded: if the path filter itself failed, every job
# downstream of it is "skipped" and would otherwise read as intentionally
# skipped. Every other job passes on success or on an intentional skip; failure
# and cancelled fail the gate.
set -euo pipefail

status=0
{
  echo "| job | result |"
  echo "|---|---|"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

for pair in "$@"; do
  job=${pair%%=*}
  result=${pair#*=}
  echo "| $job | $result |" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  if [ "$job" = changes ]; then
    ok=$([ "$result" = success ] && echo yes || echo no)
  else
    case "$result" in
      success | skipped) ok=yes ;;
      *) ok=no ;;
    esac
  fi
  if [ "$ok" = yes ]; then
    echo "ok    $job: $result"
  else
    echo "::error::$job: $result"
    status=1
  fi
done

exit "$status"
