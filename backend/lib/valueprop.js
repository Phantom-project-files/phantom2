// lib/valueprop.js — the pre-payment hook (script-gen BPMN sheet):
// "value proposition is x3 16:9 frames on 'How can Phantom help the business'".
//
// Frame recipe from the sheet's three template boxes:
//   1. What is [Business] — segment, product/service, target market, location
//   2. Social media presence — follower counts / platforms found (or the gap)
//   3. Posting cadence — how often they post vs. Phantom's 1 reel + 1 post daily
//
// Runs as a `value_prop` job right after a successful scrape (runner enqueues it).
// One synthesis-tier LLM call; frames are rendered as styled 16:9 HTML slides by
// proposal.html (no image-gen spend in the funnel).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { intakes, scrapeSources, events } from './db.js';
import { storage } from './storage.js';
import { logEvent } from './logs.js';
import { llm } from './llm.js';
import * as jobs from './jobs.js';
import { sendEmail } from './email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MOCK_FRAMES = JSON.stringify({
  frames: [
    { eyebrow: 'Meet your brand', headline: 'Mock Brand sells great products to people who care.', body: 'DTC, Los Angeles. A clear catalog and a clear audience — exactly what content should amplify.', stat: null },
    { eyebrow: 'Your social reality', headline: 'An audience is waiting. Your feed is quiet.', body: 'Instagram found, TikTok found — but posting is inconsistent and comments go unanswered.', stat: '515K reachable followers' },
    { eyebrow: 'The Phantom fix', headline: '1 reel + 1 post. Every single day. Zero effort.', body: 'Six AI creators built from your brand DNA write, shoot, and deliver a month of content while you run the business.', stat: '30 reels · 30 posts / mo' },
  ],
});

async function loadScrape(intake) {
  // Prefer the artifact; local backend keeps it on disk under data/media/<key>.
  if (!intake.scrape_key) return null;
  try {
    if (storage.backend === 'local') {
      const fp = path.join(__dirname, '..', 'data', 'media', intake.scrape_key);
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
    const url = await storage.signedGet(intake.tenant_slug, intake.scrape_key, 120);
    const r = await fetch(url);
    return await r.json();
  } catch { return null; }
}

export async function runValueProp({ intakeId }) {
  const intake = intakes.byId(intakeId);
  if (!intake) throw new Error(`intake ${intakeId} not found`);
  const scrape = await loadScrape(intake);
  const sources = scrapeSources.byIntake(intakeId);
  const social = sources.filter((s) => s.source !== 'website')
    .map(({ source, status, note, data }) => ({ source, status, note, followers: data ? (JSON.parse(data)?.followers_text || null) : null }));

  const prompt = `Build Phantom's 3-frame value proposition for "${intake.business_name}" — the pitch shown right before pricing. Frame arc (fixed):
  1. WHO THEY ARE — segment, what they sell, who for, where (from the scrape).
  2. THEIR SOCIAL REALITY — platforms + follower counts found below; name the gap honestly (quiet feed, inconsistent posting, unanswered audience).
  3. THE PHANTOM FIX — six AI creators from their brand DNA deliver 1 reel + 1 post daily; make it feel inevitable.

Tone: sharp, concrete, second person ("you"), no fluff. Each frame fits a 16:9 slide.

Scrape summary: ${JSON.stringify({ about: scrape?.about, target_market: scrape?.target_market?.who_are_they, products: scrape?.products_services?.segment, vertical: scrape?.vertical?.vertical })}
Social sources: ${JSON.stringify(social)}

Return ONLY JSON:
{ "frames": [ { "eyebrow": string, "headline": string, "body": string, "stat": string|null } ] }
Exactly 3 frames. headline ≤ 10 words. body ≤ 40 words. stat = one number+unit or null.`;

  const raw = await llm.complete({
    task: 'synthesis',
    system: 'You are Phantom 2.0\'s value-proposition writer. Ground every claim in the provided scrape data; never invent metrics.',
    prompt,
    schema: { type: 'json', required: ['frames'], shape: { frames: 'array' } },
    tenant: intake.tenant_slug,
    mock: MOCK_FRAMES,
  });
  const valueProp = JSON.parse(raw);
  if (!Array.isArray(valueProp.frames) || valueProp.frames.length !== 3) {
    throw new Error(`value prop must be exactly 3 frames (got ${valueProp.frames?.length})`);
  }
  intakes.patch(intakeId, { valueProp });
  events.record({ tenantSlug: intake.tenant_slug, name: 'valueprop.ready', props: { intakeId } });
  logEvent({ event: 'valueprop.ready', tenantSlug: intake.tenant_slug, refId: intakeId });
  // Stage email (skeleton): fires only when the intake is already claimed by a user.
  if (intake.claimed_user_id) {
    sendEmail({ intakeId, template: 'proposal_ready', tenantSlug: intake.tenant_slug });
  }
  return { ok: true, frames: valueProp.frames.length };
}

export function registerValuePropJobs() {
  jobs.register('value_prop', (payload) => runValueProp(payload), { concurrency: 2 });
}
