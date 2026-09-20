#!/bin/bash
# Stage the Supabase function directory + sanity checks.
# Run from the repo root:  bash tools/cloud-build.sh
set -e
cd "$(dirname "$0")/.."
F=supabase/functions/viralytics

# single source of truth: the cores live in tools/, get copied next to index.ts
cp tools/crawl-core.mjs  "$F/crawl-core.mjs"
cp tools/bake-core.mjs   "$F/bake-core.mjs"
cp tools/report-core.mjs "$F/report-core.mjs"

# node-side sanity (cores must still run on Node — same code, two shells)
node -e "
  const c = require('./tools/live.js');
  if (typeof c.collect !== 'function' || typeof c.quick !== 'function') throw new Error('live.js exports broken');
  console.log('  ✓ live.js (node shell) exports ok');
"
node -e "
  (async () => {
    const b = await import('./tools/bake-core.mjs');
    const r = await import('./tools/report-core.mjs');
    if (typeof b.bake !== 'function' || typeof r.makePlan !== 'function') throw new Error('core exports broken');
    console.log('  ✓ bake-core + report-core import ok (Deno-compatible: no node: imports)');
  })();
"

# verify no Node-only modules slipped into the cloud code
if grep -nE "require\(|from 'node:|from \"node:" "$F"/*.mjs "$F/index.ts" | grep -v "^\s*//" ; then
  echo "  ✗ node-only import found in cloud code" ; exit 1
fi
echo "  ✓ no node:-only imports in cloud code"

# deno type-check if a deno binary exists (optional, best effort)
if command -v deno >/dev/null 2>&1; then
  deno check "$F/index.ts" && echo "  ✓ deno check ok"
else
  echo "  – deno not installed here; skipping type-check (runtime is Deno 2 on Supabase)"
fi
echo "  staged: $F/"
ls -la "$F"
