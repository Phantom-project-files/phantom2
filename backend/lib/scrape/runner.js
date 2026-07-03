// lib/scrape/runner.js — Agent-Scraper orchestration (Phase 1).
//
// Runs as a `scrape` job (lib/jobs.js — concurrency-capped, restart-safe,
// retry/backoff). Flow:
//
//   1. fetch homepage (ladder) → blocked? flag website source + fail honestly
//   2. discoverPages → fetch about/products/faq (bounded: SCRAPE_MAX_PAGES)
//   3. deterministic extraction (metadata/images/handles/tech — $0)
//   4. gated LLM passes over taxonomy SECTIONS, budget-capped
//      (SCRAPE_LLM_CALL_BUDGET, default 10 — the "gate it for token spend" note)
//   5. social probes (public fetch only) → per-source honest status rows
//   6. assemble scrape.json → R2 (tenants/<slug>/scrapes/…) → intakes.scrape_key
//
// Every source attempt lands in scrape_sources so the operator console shows
// exactly what was scraped vs. what needs Apify.

import { nanoid } from 'nanoid';
import { intakes, scrapeSources, tenants, events } from '../db.js';
import { storage } from '../storage.js';
import { logEvent } from '../logs.js';
import { llm } from '../llm.js';
import * as jobs from '../jobs.js';
import { fetchPage, detectBlocked, discoverPages, extractDeterministic } from './fetcher.js';
import { SECTIONS, assembleScrape } from './taxonomy.js';
import { probeAll } from './social.js';

const MAX_PAGES = () => parseInt(process.env.SCRAPE_MAX_PAGES || '6', 10);
const LLM_BUDGET = () => parseInt(process.env.SCRAPE_LLM_CALL_BUDGET || '10', 10);

async function fetchAux(urls, kind, pages, flags) {
  for (const url of urls) {
    if (pages.length >= MAX_PAGES()) return;
    try {
      const { html } = await fetchPage(url, 10000);
      const block = detectBlocked(html);
      if (block.blocked) { flags.push(`page ${url}: ${block.reason}`); continue; }
      const det = extractDeterministic(html, url);
      pages.push({ url, kind, text: det.text.slice(0, 8000), det });
    } catch (err) {
      flags.push(`page ${url}: ${err.message}`);
    }
  }
}

export async function runScrape({ intakeId }) {
  const intake = intakes.byId(intakeId);
  if (!intake) throw new Error(`intake ${intakeId} not found`);
  intakes.patch(intakeId, { status: 'scraping' });
  const flags = [];
  const slug = intake.tenant_slug;

  // 1-2. crawl (homepage is load-bearing; aux pages are best-effort)
  let home;
  try {
    home = await fetchPage(intake.website);
  } catch (err) {
    scrapeSources.upsert({ intakeId, source: 'website', handle: intake.website, status: 'failed', note: err.message });
    intakes.patch(intakeId, { status: 'failed', error: `homepage fetch: ${err.message}`, flags: [`homepage unreachable: ${err.message}`] });
    logEvent({ level: 'error', event: 'scrape.failed', tenantSlug: slug, refId: intakeId, message: err.message });
    return { ok: false, error: err.message };
  }
  const homeBlock = detectBlocked(home.html, home.status);
  if (homeBlock.blocked) {
    scrapeSources.upsert({ intakeId, source: 'website', handle: intake.website, status: 'blocked_needs_apify', note: homeBlock.reason });
    intakes.patch(intakeId, { status: 'failed', error: `homepage blocked: ${homeBlock.reason}`, flags: [`website blocked (${homeBlock.reason}) — needs headless/Apify rung`] });
    logEvent({ level: 'warn', event: 'scrape.blocked', tenantSlug: slug, refId: intakeId, message: homeBlock.reason });
    return { ok: false, blocked: true };
  }

  const deterministic = extractDeterministic(home.html, intake.website);
  const pages = [{ url: intake.website, kind: 'home', text: deterministic.text.slice(0, 8000), det: deterministic }];
  const discovered = process.env.SCRAPE_OFFLINE === '1'
    ? { about: [], products: [], faq: [] }
    : discoverPages(home.html, intake.website);
  await fetchAux(discovered.about, 'about', pages, flags);
  await fetchAux(discovered.products, 'products', pages, flags);
  await fetchAux(discovered.faq, 'faq', pages, flags);
  scrapeSources.upsert({
    intakeId, source: 'website', handle: intake.website, status: 'scraped',
    note: `${pages.length} page(s) via ${home.rung} rung`,
    data: { pages: pages.map((p) => p.url), tech: deterministic.tech },
  });

  // 4. gated LLM taxonomy passes (budget-capped)
  const ctx = { businessName: intake.business_name, pages, deterministic, sections: {} };
  let llmCalls = 0;
  for (const section of SECTIONS) {
    if (llmCalls >= LLM_BUDGET()) { flags.push(`token budget hit (${llmCalls} calls) — '${section.key}' + later sections skipped`); break; }
    if (!section.gate(ctx)) { flags.push(`section '${section.key}' gated off (insufficient signal)`); continue; }
    try {
      llmCalls++;
      const raw = await llm.complete({
        task: section.tier,
        system: 'You are Phantom 2.0\'s Agent-Scraper. Extract only what the evidence supports; prefer null over invention. Output ONLY the requested JSON — no prose.',
        prompt: section.prompt(ctx),
        schema: section.schema,
        tenant: slug,
        mock: section.mock,
      });
      ctx.sections[section.key] = JSON.parse(raw);
    } catch (err) {
      flags.push(`section '${section.key}' failed: ${err.message}`);
      logEvent({ level: 'warn', event: 'scrape.section_failed', tenantSlug: slug, refId: intakeId, message: `${section.key}: ${err.message}` });
    }
  }
  if (ctx.sections.vertical?.vertical) tenants.setVertical(slug, ctx.sections.vertical.vertical);

  // 5. social probes → honest per-source rows
  const probes = await probeAll(deterministic.handles);
  for (const p of probes) {
    scrapeSources.upsert({ intakeId, source: p.platform, handle: p.handle, status: p.status, note: p.note, data: p.data });
  }
  const needApify = probes.filter((p) => p.status === 'blocked_needs_apify').map((p) => p.platform);
  if (needApify.length) flags.push(`needs Apify for deep data: ${needApify.join(', ')}`);

  // 6. assemble + persist
  const sources = scrapeSources.byIntake(intakeId).map(({ source, handle, status, note }) => ({ source, handle, status, note }));
  const scrape = assembleScrape({ intake, deterministic, pages, sections: ctx.sections, sources, flags, llmCalls });
  const key = storage.makeKey(slug, 'scrape', 'json');
  await storage.put(slug, key, Buffer.from(JSON.stringify(scrape, null, 2)), 'application/json');

  const finalStatus = flags.some((f) => /failed|budget hit/.test(f)) ? 'partial' : 'scraped';
  intakes.patch(intakeId, { status: finalStatus, scrapeKey: key, llmCalls, flags });
  events.record({ tenantSlug: slug, name: 'scrape.completed', props: { intakeId, status: finalStatus, llmCalls, sources: sources.length } });
  logEvent({ event: 'scrape.completed', tenantSlug: slug, refId: intakeId, message: `${finalStatus} — ${pages.length} pages, ${llmCalls} LLM calls, ${sources.length} sources` });
  return { ok: true, status: finalStatus, scrapeKey: key, llmCalls };
}

// Boot wiring: server.js calls registerScrapeJobs() once before jobs.start().
export function registerScrapeJobs() {
  jobs.register('scrape', (payload) => runScrape(payload), { concurrency: 2 });
}

// Create an intake (+tenant) and queue its scrape. The Phase-2 public funnel and
// the operator sandbox both call this.
export function startIntake({ businessName, website }) {
  const url = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  new URL(url); // throws on garbage before we mint anything
  const tenant = tenants.create({ businessName, website: url, suffix: nanoid(4).toLowerCase().replace(/[^a-z0-9]/g, 'x') });
  const intake = intakes.create({ id: nanoid(12), tenantSlug: tenant.slug, businessName, website: url });
  jobs.enqueue({ kind: 'scrape', tenantSlug: tenant.slug, refKind: 'intake', refId: intake.id, payload: { intakeId: intake.id }, maxAttempts: 2 });
  events.record({ tenantSlug: tenant.slug, name: 'intake.created', props: { intakeId: intake.id, website: url } });
  return { intake, tenant };
}
