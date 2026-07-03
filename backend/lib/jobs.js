// lib/jobs.js — the render/generation work queue (Phase 0 spine).
//
// WHY THIS EXISTS (v1 post-mortem, 2026-06-24): v1 ran renders in-process with no
// cap — 30 posts fired concurrently on a 1 vCPU box and stalled forever; and pipeline
// progress only advanced while a browser tab polled, stranding 5 brands' faces. So:
//   - every unit of work is a `jobs` row (survives restarts; requeued on boot)
//   - a single in-process worker claims jobs with a PER-KIND CONCURRENCY CAP
//   - retries with exponential backoff up to max_attempts
//   - BILLING CIRCUIT-BREAKER: a billing-class failure (insufficient credits, 402…)
//     fails the job immediately AND halts every queued sibling of the same
//     (kind, tenant) — no more burning a 30-piece batch against an empty provider.
//
// Usage:
//   register('fal_video', handler, { concurrency: 4 })   // handler(payload, jobRow) → result
//   enqueue({ kind:'fal_video', tenantSlug, payload })
//   start()  — call once at boot (server.js)
//
// Concurrency defaults come from $JOBS_CONCURRENCY (JSON: {"fal_video":4,...}),
// falling back to the register() option, falling back to 2.

import { jobs as store } from './db.js';
import { logEvent } from './logs.js';

const handlers = new Map();   // kind → { fn, concurrency, running }
let timer = null;
const TICK_MS = 500;

function envConcurrency(kind) {
  try {
    const cfg = JSON.parse(process.env.JOBS_CONCURRENCY || '{}');
    if (Number.isInteger(cfg[kind]) && cfg[kind] > 0) return cfg[kind];
  } catch { /* bad JSON → ignore */ }
  return null;
}

export function register(kind, fn, { concurrency = 2 } = {}) {
  handlers.set(kind, { fn, concurrency: envConcurrency(kind) ?? concurrency, running: 0 });
}

export function enqueue(spec) {
  const id = store.enqueue(spec);
  setImmediate(tick); // don't wait for the next interval
  return id;
}

// Billing-class error detection: providers phrase it differently; an explicit
// err.billing=true from a handler always wins.
const BILLING_RE = /insufficient credit|insufficient balance|payment required|billing|quota exceeded|subscription plan does not support/i;
export function isBillingError(err) {
  return err?.billing === true || err?.status === 402 || BILLING_RE.test(String(err?.message || err));
}

const backoff = (attempts) => Math.min(600, 15 * 2 ** attempts); // 30s, 60s, 120s… cap 10min

async function runJob(kind, entry, job) {
  entry.running++;
  try {
    const payload = job.payload ? JSON.parse(job.payload) : {};
    const result = await entry.fn(payload, job);
    store.done(job.id, result ?? null);
  } catch (err) {
    if (isBillingError(err)) {
      store.fail(job.id, `BILLING: ${err.message}`);
      const halted = store.haltSiblings({ kind, tenantSlug: job.tenant_slug, reason: `billing failure (${err.message})`.slice(0, 200) });
      logEvent({
        level: 'error', event: 'jobs.billing_halt', tenantSlug: job.tenant_slug,
        message: `${kind} job ${job.id} hit a billing error — halted ${halted} queued sibling(s). Refill the provider, then re-enqueue.`,
        meta: { kind, error: String(err.message).slice(0, 300) },
      });
    } else if (job.attempts >= job.max_attempts) {
      store.fail(job.id, err.message);
      logEvent({ level: 'error', event: 'jobs.failed', tenantSlug: job.tenant_slug, refId: job.id, message: `${kind}: ${err.message}`.slice(0, 500) });
    } else {
      // handlers may set err.retryAfterSec for known-short waits (e.g. "phantom
      // ref not ready") so dependency chains don't sit in the generic backoff
      const delay = Number.isFinite(err?.retryAfterSec) ? err.retryAfterSec : backoff(job.attempts);
      store.retry(job.id, Math.floor(Date.now() / 1000) + delay, err.message);
    }
  } finally {
    entry.running--;
    setImmediate(tick); // a slot freed — try to claim more
  }
}

function tick() {
  for (const [kind, entry] of handlers) {
    while (entry.running < entry.concurrency) {
      const job = store.claim(kind);
      if (!job) break;
      runJob(kind, entry, job); // intentionally not awaited — cap enforced by entry.running
    }
  }
}

export function start() {
  const orphans = store.requeueOrphans();
  if (orphans) console.log(`[jobs] requeued ${orphans} orphaned running job(s) from previous boot`);
  if (!timer) timer = setInterval(tick, TICK_MS).unref();
  const caps = [...handlers.entries()].map(([k, e]) => `${k}:${e.concurrency}`).join(', ') || '(no handlers yet)';
  console.log(`[jobs] worker started — ${caps}`);
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function summary() { return store.summary(); }
