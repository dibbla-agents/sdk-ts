#!/usr/bin/env bash
# Assembles a deploy directory for the dev-cluster test worker:
#   devtest/bundle.sh <out-dir>
# then deploy it with the command printed at the end.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:?usage: devtest/bundle.sh <out-dir>}"
mkdir -p "$out"
(cd "$repo" && npm run build >/dev/null)
tarball="$(cd "$repo" && npm pack --silent --pack-destination "$out" | tail -1)"
mv "$out/$tarball" "$out/dibbla-agents-sdk-ts.tgz"
cp "$repo/devtest/Dockerfile" "$repo/devtest/entry.ts" "$repo/devtest/REVIEW.md" "$repo/devtest/APP.md" "$out/"
cp "$repo/conformance/workers/ts/worker.ts" "$out/worker.ts"
printf '{"name":"sdk-ts-devtest","private":true}\n' > "$out/package.json"
cat <<MSG
Bundled $tarball into $out. Deploy to the dev cluster with:
  dibbla deploy "$out" --alias sdk-ts-devtest --no-public --port 80 \\
    -e SERVER_NAME=sdk-ts-devtest -e GRPC_SERVER_ADDRESS=grpc.dibbla.net:443 \\
    -e CONFORMANCE_PING_INTERVAL_SEC=30
MSG
