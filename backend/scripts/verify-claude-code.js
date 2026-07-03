// scripts/verify-claude-code.js — REAL verification of CLAUDE_MODE=claude_code.
// Runs ONE tiny summary-tier completion through the operator's logged-in Claude
// Code CLI (Max subscription — $0 API spend). Scratch DB; safe to run anytime.
//   node scripts/verify-claude-code.js

import fs from 'fs';
import os from 'os';
import path from 'path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom2-cc-'));
process.env.PHANTOM_DB_PATH = path.join(scratch, 'cc.db');
process.env.CLAUDE_MODE = 'claude_code';
process.env.CLAUDE_CODE_TIMEOUT_MS = '120000';

const { llm } = await import('../lib/llm.js');
const { costEvents } = await import('../lib/db.js');

console.log('[cc] mode:', llm.mode, '— invoking the local claude CLI (haiku tier, one tiny prompt)…');
const t0 = Date.now();
try {
  const out = await llm.complete({
    task: 'summary',
    system: 'You answer with exactly the requested JSON and nothing else.',
    prompt: 'Return ONLY this JSON with the math done: { "answer": <what is 17 + 25>, "word": "phantom" }',
    schema: { type: 'json', required: ['answer', 'word'] },
  });
  const parsed = JSON.parse(out);
  const ok = parsed.answer === 42 && parsed.word === 'phantom';
  console.log(`  ${ok ? '✓' : '✗ FAIL'} local claude_code completion (${((Date.now() - t0) / 1000).toFixed(1)}s): ${out.slice(0, 80)}`);
  const zeroCost = costEvents.totalsSince(0).find((r) => r.provider === 'claude_code');
  console.log(`  ${zeroCost && zeroCost.usd === 0 ? '✓' : '✗ FAIL'} $0 cost marker recorded (Max subscription, no API spend)`);
  console.log(ok && zeroCost ? '\n[cc] CLAUDE_CODE MODE VERIFIED ✅ — the whole pipeline can run on the Max plan locally' : '\n[cc] FAILED ❌');
  process.exit(ok && zeroCost ? 0 : 1);
} catch (err) {
  console.error(`  ✗ claude_code call failed: ${err.message}`);
  process.exit(1);
}
