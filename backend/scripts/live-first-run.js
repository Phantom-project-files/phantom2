// scripts/live-first-run.js — post-build checklist item 1: first funded Fal run.
// Enqueues ONLY: phantoms 7 (Maya) + 10 (Leo), then (--pieces) reel 151 + post 154.
// Run against the RUNNING server's queue (this process only enqueues; the server executes).
// Usage: node scripts/live-first-run.js [--phantoms|--pieces|--status]
import 'dotenv/config';
import { phantoms, pieces } from '../lib/db.js';
import * as jobs from '../lib/jobs.js';

const PHANTOM_IDS = [7, 10];
const REEL_ID = 151;
const POST_ID = 154;
const mode = process.argv[2] || '--status';

if (process.env.MOCK_MEDIA_GEN === '1') {
  console.error('MOCK_MEDIA_GEN=1 — this is supposed to be the LIVE run. Aborting.');
  process.exit(1);
}

if (mode === '--phantoms') {
  for (const id of PHANTOM_IDS) {
    const ph = phantoms.byId(id);
    if (!ph) throw new Error(`phantom ${id} missing`);
    if (ph.status === 'ready' && ph.ref_image_key) { console.log(`phantom ${id} (${ph.name}) already ready`); continue; }
    jobs.enqueue({ kind: 'render_phantom', tenantSlug: ph.tenant_slug, refKind: 'phantom', refId: ph.id, payload: { phantomId: ph.id }, maxAttempts: 3 });
    console.log(`enqueued render_phantom ${id} (${ph.name})`);
  }
} else if (mode === '--pieces') {
  for (const id of PHANTOM_IDS) {
    const ph = phantoms.byId(id);
    if (ph.status !== 'ready') { console.error(`phantom ${id} (${ph.name}) not ready (${ph.status}) — run --phantoms and wait first`); process.exit(1); }
  }
  const reel = pieces.byId(REEL_ID); const post = pieces.byId(POST_ID);
  jobs.enqueue({ kind: 'render_reel', tenantSlug: reel.tenant_slug, refKind: 'piece', refId: reel.id, payload: { pieceId: reel.id }, maxAttempts: 6 });
  jobs.enqueue({ kind: 'render_post', tenantSlug: post.tenant_slug, refKind: 'piece', refId: post.id, payload: { pieceId: post.id }, maxAttempts: 6 });
  console.log(`enqueued render_reel ${REEL_ID} + render_post ${POST_ID}`);
} else {
  for (const id of PHANTOM_IDS) { const ph = phantoms.byId(id); console.log(`phantom ${id} ${ph.name}: ${ph.status}${ph.ref_image_key ? ' ref=' + ph.ref_image_key : ''}`); }
  for (const id of [REEL_ID, POST_ID]) { const p = pieces.byId(id); console.log(`piece ${id} (${p.kind}): ${p.status}`); }
  console.log(JSON.stringify(jobs.summary(), null, 1));
}
