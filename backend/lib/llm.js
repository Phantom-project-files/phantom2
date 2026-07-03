// lib/llm.js — the single LLM boundary for Phantom 2.0. Every Claude call goes
// through complete() here. CLAUDE_MODE picks the backend:
//
//   mock          — DEFAULT. Deterministic canned output, $0. Spend is opt-in, never
//                   the default (v1 lesson: its default mode crashed on stock boxes).
//   claude_code   — the operator's LOCAL logged-in Claude Code CLI (Max subscription).
//                   $0 API spend; only valid on the operator's machine. Prod must not
//                   use this — it requires an interactive `claude` login.
//   anthropic_api — real Anthropic SDK (prod). ANTHROPIC_API_KEY required.
//
// Model routing (the BPMN sticky notes: "use sonnet", "gate it for token spend"):
// callers pass a task TIER, not a model id —
//   synthesis   → creative work (value prop, campaign ideation, scripts)   → Opus
//   extraction  → structured pulls from scraped pages, classification      → Sonnet
//   summary     — cheap rollups (QC learnings, coverage notes)             → Haiku
// Tier→model ids are env-overridable (ANTHROPIC_MODEL_SYNTHESIS / _EXTRACTION / _SUMMARY).
//
// SECURITY: withPreamble() prepends the injection-defense system preamble on every
// call; callers wrap untrusted scraped content with safety.wrapUntrusted() themselves.
// Structured output is validated with safety.validateOutput(schema) and retried once
// with the validation error appended (api + claude_code modes).

import { spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { withPreamble, validateOutput } from './safety.js';
import { costEvents } from './db.js';
import { logEvent } from './logs.js';

const MODE = () => (process.env.CLAUDE_MODE || 'mock').toLowerCase();

const TIER_MODELS = () => ({
  synthesis: process.env.ANTHROPIC_MODEL_SYNTHESIS || 'claude-opus-4-8',
  extraction: process.env.ANTHROPIC_MODEL_EXTRACTION || 'claude-sonnet-5',
  summary: process.env.ANTHROPIC_MODEL_SUMMARY || 'claude-haiku-4-5',
});
// Claude Code CLI accepts friendly aliases — map tiers for claude_code mode.
const TIER_CLI_ALIAS = { synthesis: 'opus', extraction: 'sonnet', summary: 'haiku' };

// USD per MTok — estimates for the cost dashboard, not billing-grade. Env-overridable
// via LLM_PRICES_JSON = {"claude-opus-4-8":[15,75],...} ([input,output] per MTok).
const DEFAULT_PRICES = {
  'claude-opus-4-8': [15, 75],
  'claude-sonnet-5': [3, 15],
  'claude-haiku-4-5': [1, 5],
};
function priceFor(model) {
  let table = DEFAULT_PRICES;
  try { table = { ...DEFAULT_PRICES, ...JSON.parse(process.env.LLM_PRICES_JSON || '{}') }; } catch {}
  const hit = Object.entries(table).find(([k]) => model.startsWith(k));
  return hit ? hit[1] : [3, 15];
}

let _anthropic = null;
function anthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ── backends ─────────────────────────────────────────────────────────────────

async function callAnthropicApi({ model, system, prompt, maxTokens, task, tenant }) {
  const msg = await anthropic().messages.create({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  try {
    const [inP, outP] = priceFor(model);
    const usd = ((msg.usage?.input_tokens || 0) * inP + (msg.usage?.output_tokens || 0) * outP) / 1e6;
    costEvents.record({
      tenantSlug: tenant || null, provider: 'anthropic', model, operation: task,
      refId: msg.id, inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens, usd,
    });
  } catch { /* cost logging is best-effort */ }
  return text;
}

// Local logged-in Claude Code CLI. Prompt goes in on stdin (arbitrary length),
// `--output-format json` gives a parseable envelope with a .result field.
function callClaudeCode({ tier, system, prompt, task, tenant }) {
  const bin = process.env.CLAUDE_CODE_BIN || 'claude';
  const timeoutMs = parseInt(process.env.CLAUDE_CODE_TIMEOUT_MS || '300000', 10);
  const args = ['-p', '--output-format', 'json', '--model', TIER_CLI_ALIAS[tier] || 'sonnet'];
  const full = system ? `${system}\n\n---\n\n${prompt}` : prompt;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', errBuf = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude_code timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errBuf += d; });
    child.on('error', (e) => {
      clearTimeout(killer);
      if (e.code === 'ENOENT') {
        reject(new Error(`claude_code mode: '${bin}' CLI not found — this mode only works on a machine with a logged-in Claude Code install (set CLAUDE_MODE=mock or anthropic_api instead)`));
      } else reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error(`claude_code exited ${code}: ${errBuf.slice(0, 400)}`));
      try {
        const envelope = JSON.parse(out);
        const text = typeof envelope.result === 'string' ? envelope.result : out;
        try {
          costEvents.record({
            tenantSlug: tenant || null, provider: 'claude_code',
            model: TIER_CLI_ALIAS[tier], operation: task, usd: 0,
            meta: { note: 'Max-subscription local call — $0 API' },
          });
        } catch { /* best-effort */ }
        resolve(text);
      } catch {
        resolve(out); // non-JSON output — return raw rather than fail
      }
    });
    child.stdin.write(full);
    child.stdin.end();
  });
}

function callMock({ task, opts }) {
  if (opts.mock != null) return typeof opts.mock === 'string' ? opts.mock : JSON.stringify(opts.mock);
  return JSON.stringify({ mock: true, task });
}

// ── public API ───────────────────────────────────────────────────────────────
//
// complete({ task, system, prompt, schema, maxTokens, tenant, mock })
//   task     — 'synthesis' | 'extraction' | 'summary' (default 'extraction')
//   schema   — safety.validateOutput schema ({type:'json',required,shape} | {type:'html'})
//   mock     — canned output for CLAUDE_MODE=mock runs
// Returns the raw text (or validated text when schema given). Throws on failure.

export async function complete({
  task = 'extraction', system = '', prompt, schema = null,
  maxTokens = 4096, tenant = null, ...opts
} = {}) {
  if (!prompt) throw new Error('llm.complete: prompt required');
  const mode = MODE();
  const sys = withPreamble(system);

  if (mode === 'mock') {
    return callMock({ task, opts }); // mock skips schema validation — callers control the canned shape
  }

  const runOnce = async (extraNote) => {
    const p = extraNote ? `${prompt}\n\n[RETRY — previous output failed validation: ${extraNote}. Return ONLY the corrected output.]` : prompt;
    if (mode === 'claude_code') {
      return await callClaudeCode({ tier: task, system: sys, prompt: p, task, tenant });
    }
    if (mode === 'anthropic_api') {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('CLAUDE_MODE=anthropic_api but ANTHROPIC_API_KEY is not set');
      return await callAnthropicApi({ model: TIER_MODELS()[task] || TIER_MODELS().extraction, system: sys, prompt: p, maxTokens, task, tenant });
    }
    throw new Error(`unknown CLAUDE_MODE '${mode}' (mock | claude_code | anthropic_api)`);
  };

  let text = await runOnce();
  if (schema) {
    let v = validateOutput(text, schema);
    if (!v.ok) {
      logEvent({ level: 'warn', event: 'llm.schema_retry', message: v.error, meta: { task, mode } });
      text = await runOnce(v.error);
      v = validateOutput(text, schema);
      if (!v.ok) throw new Error(`llm output failed validation after retry: ${v.error}`);
    }
    return typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
  }
  return text;
}

// vision() — image+text calls (product-shot picking, QC eyeballing). anthropic_api
// only; claude_code has no image stdin path, mock returns the canned output.
export async function vision({ prompt, images = [], schema = null, maxTokens = 2048, tenant = null, ...opts } = {}) {
  const mode = MODE();
  if (mode === 'mock') return callMock({ task: 'vision', opts });
  if (mode !== 'anthropic_api') {
    throw new Error(`vision requires CLAUDE_MODE=anthropic_api (current: ${mode})`);
  }
  const model = TIER_MODELS().extraction;
  const content = [
    ...images.map((img) => ({
      type: 'image',
      source: img.url
        ? { type: 'url', url: img.url }
        : { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.base64 },
    })),
    { type: 'text', text: prompt },
  ];
  const msg = await anthropic().messages.create({
    model, max_tokens: maxTokens,
    system: withPreamble(''),
    messages: [{ role: 'user', content }],
  });
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  try {
    const [inP, outP] = priceFor(model);
    costEvents.record({
      tenantSlug: tenant || null, provider: 'anthropic', model, operation: 'vision',
      refId: msg.id, inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens,
      usd: ((msg.usage?.input_tokens || 0) * inP + (msg.usage?.output_tokens || 0) * outP) / 1e6,
    });
  } catch { /* best-effort */ }
  if (schema) {
    const v = validateOutput(text, schema);
    if (!v.ok) throw new Error(`vision output failed validation: ${v.error}`);
    return typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
  }
  return text;
}

export const llm = {
  get mode() { return MODE(); },
  get spends_credits() { return MODE() === 'anthropic_api'; },
  get models() { return TIER_MODELS(); },
  complete,
  vision,
};
export default llm;
