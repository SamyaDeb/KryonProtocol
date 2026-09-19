#!/usr/bin/env bash
# Decide which CI areas a change touches. Reads changed paths on stdin, one per
# line, and writes `<area>=true|false` lines for $GITHUB_OUTPUT.
#
# Fail-safe by design: a path that no rule claims turns EVERY area on, so a new
# top-level directory runs the full pipeline until someone teaches this file
# about it. Only paths positively known to be documentation are skippable.
#
#   .github/**, .nvmrc, anything unknown  -> everything
#   kryon-protocol/infra/**               -> everything under kryon-protocol
#                                            plus client and integration (the
#                                            runbooks are .md, but the client
#                                            tests and forge scripts read them)
#   docs/**, **/*.md                      -> nothing but the guards
#   client/**                             -> client, integration, security
#   kryon-protocol/prisma/**              -> prisma, client, integration
#   kryon-protocol/evm/**                 -> evm, client, integration (the
#                                            client reads deployment records)
#   kryon-protocol/** (anything else:     -> everything under kryon-protocol
#     crates, Cargo.*, package*)             plus client and integration
set -euo pipefail

client=false; evm=false; rust=false; prisma=false; integration=false; security=false; all=false
n=0

while IFS= read -r f; do
  [ -z "$f" ] && continue
  n=$((n + 1))
  case "$f" in
    .github/*) all=true ;;
    kryon-protocol/infra/*) rust=true; evm=true; prisma=true; client=true; integration=true ;;
    docs/* | *.md) ;;
    client/*) client=true; integration=true; security=true ;;
    kryon-protocol/prisma/*) prisma=true; client=true; integration=true ;;
    kryon-protocol/evm/*) evm=true; client=true; integration=true ;;
    kryon-protocol/*) rust=true; evm=true; prisma=true; client=true; integration=true ;;
    *) all=true ;;
  esac
done

# An empty diff is not evidence of a docs-only change; run everything.
[ "$n" -eq 0 ] && all=true

if [ "$all" = true ]; then
  client=true; evm=true; rust=true; prisma=true; integration=true; security=true
fi

echo "client=$client"
echo "evm=$evm"
echo "rust=$rust"
echo "prisma=$prisma"
echo "integration=$integration"
echo "security=$security"
echo "files=$n"
