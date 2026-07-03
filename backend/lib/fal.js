// lib/fal.js — thin Fal.ai queue client (replaces v1's Enhancor).
//
// Model ids are CONFIG-PINNED, never hardcoded at call sites:
//   $FAL_IMAGE_MODEL      (default fal-ai/nano-banana-pro)       — text→image
//   $FAL_IMAGE_EDIT_MODEL (default fal-ai/nano-banana-pro/edit)  — image+ref→image (phantom-ref gens)
//   $FAL_VIDEO_MODEL      (default bytedance/seedance-2.0/image-to-video) — keyframe→video
// Ids + input schemas verified against fal.ai OpenAPI 2026-07-03 (see docs/PLAN.md):
// t2i takes NO image_urls (that's /edit, where image_urls is REQUIRED); seedance takes
// duration as a STRING enum "4".."15" and has generate_audio defaulting true.
//
// Fal queue API: POST https://queue.fal.run/<model>  (auth: `Key <FAL_KEY>`)
//   → { request_id, status_url, response_url }  — then poll, or better, pass
//   ?fal_webhook=<url> and let POST /webhook/fal advance the job (v1 lesson: polling
//   loops died with the browser tab; webhooks + the jobs table don't).
//
// classifyError() feeds the jobs-queue billing circuit-breaker (err.billing=true
// halts sibling jobs instead of burning a whole batch — the Enhancor-401 lesson).
//
// MOCK_MEDIA_GEN=1 → no network, deterministic fake request ids ($0 local runs).

import { logEvent } from './logs.js';

const FAL_QUEUE = 'https://queue.fal.run';

export const MODELS = {
  get image() { return process.env.FAL_IMAGE_MODEL || 'fal-ai/nano-banana-pro'; },
  get imageEdit() { return process.env.FAL_IMAGE_EDIT_MODEL || 'fal-ai/nano-banana-pro/edit'; },
  get video() { return process.env.FAL_VIDEO_MODEL || 'bytedance/seedance-2.0/image-to-video'; },
};

const isMock = () => process.env.MOCK_MEDIA_GEN === '1';

function key() {
  const k = process.env.FAL_KEY;
  if (!k) throw new Error('FAL_KEY is not set');
  return k;
}

export function classifyError(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});
  const billing = status === 402
    || /insufficient|balance|credit|billing|payment|exhausted/i.test(text);
  const retryable = !billing && (status === 429 || status >= 500);
  const err = new Error(`fal ${status}: ${text.slice(0, 300)}`);
  err.status = status;
  err.billing = billing;
  err.retryable = retryable;
  return err;
}

async function falFetch(path, { method = 'GET', body = null } = {}) {
  const r = await fetch(`${FAL_QUEUE}/${path}`, {
    method,
    headers: { Authorization: `Key ${key()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw classifyError(r.status, data);
  return data;
}

// submit('image', {...input}, {webhookUrl}) → { request_id, ... }
export async function submit(modelKey, input, { webhookUrl = null } = {}) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`unknown fal model key '${modelKey}' (image | imageEdit | video)`);
  if (isMock()) {
    const request_id = `mock-${modelKey}-${Math.random().toString(36).slice(2, 10)}`;
    logEvent({ event: 'fal.submit', provider: 'fal', refId: request_id, message: `MOCK submit ${model}` });
    return { request_id, mock: true };
  }
  const qs = webhookUrl ? `?fal_webhook=${encodeURIComponent(webhookUrl)}` : '';
  const data = await falFetch(`${model}${qs}`, { method: 'POST', body: input });
  logEvent({ event: 'fal.submit', provider: 'fal', refId: data.request_id, message: `submitted ${model}` });
  return data;
}

export async function status(modelKey, requestId) {
  if (isMock()) return { status: 'COMPLETED', request_id: requestId, mock: true };
  return await falFetch(`${MODELS[modelKey]}/requests/${requestId}/status`);
}

export async function result(modelKey, requestId) {
  if (isMock()) return { request_id: requestId, mock: true, images: [], video: null };
  return await falFetch(`${MODELS[modelKey]}/requests/${requestId}`);
}

export default { MODELS, submit, status, result, classifyError };
