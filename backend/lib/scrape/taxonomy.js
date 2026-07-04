// lib/scrape/taxonomy.js — the Agent-Scraper contract (docs/bpmn/agent-scraper.pdf
// rendered as code). Each SECTION is one gated LLM pass over the crawled text:
//
//   { key, tier, gate(ctx), prompt(ctx), schema, mock }
//
//   tier   — llm.js task tier: 'extraction' (Sonnet) | 'synthesis' (Opus) |
//            'summary' (Haiku). The BPMN sticky notes: "use sonnet", "gate it
//            for token spend" — creative synthesis is the only Opus spend.
//   gate   — cheap deterministic check; false → section skipped + flagged, no tokens.
//   schema — safety.validateOutput shape; the LLM output is rejected+retried on miss.
//   mock   — canned output so CLAUDE_MODE=mock runs the whole pipeline for $0.
//
// Script-gen (Phase 3) consumes the assembled scrape.json AS ITS INPUT CONTRACT —
// changing a shape here is an interface change downstream.

import { wrapUntrusted } from '../safety.js';

// Follower-count buckets from the BPMN sheet (0-1K … 5M-10M).
export const FOLLOWER_BUCKETS = ['0-1K', '1K-10K', '10K-100K', '100K-500K', '500K-1M', '1M-5M', '5M-10M'];

const pagesBlock = (ctx) => ctx.pages
  .map((p) => wrapUntrusted(`[${p.kind}] ${p.url}\n${p.text}`, { label: `scraped page (${p.kind})` }))
  .join('\n\n');

export const SECTIONS = [
  {
    key: 'about',
    tier: 'extraction',
    gate: (ctx) => ctx.pages.length > 0,
    prompt: (ctx) => `You are Phantom's business-intelligence extractor. From the scraped pages below, extract the ABOUT profile of the business "${ctx.businessName}".

Return ONLY a JSON object:
{
  "business_name": string,
  "location": string|null,          // city/region if stated, else null
  "culture": string|null,           // 1-2 sentences on company culture/vibe
  "age": string|null,               // founding year or "est. X years" if stated
  "mission": string|null,
  "brand_voice": string,            // 2-3 adjectives + a sentence, inferred from copy
  "what_they_do": string,           // 1 sentence
  "problem_solved": string          // what problem do they solve, 1-2 sentences
}
Use null when the pages genuinely don't say. Do not invent facts.

${pagesBlock(ctx)}`,
    schema: { type: 'json', required: ['business_name', 'brand_voice', 'what_they_do', 'problem_solved'] },
    mock: JSON.stringify({
      business_name: 'Mock Brand', location: 'Los Angeles, CA', culture: 'Playful, direct-to-consumer.',
      age: 'est. 2021', mission: 'Make great products simple.', brand_voice: 'bold, warm, unfussy',
      what_they_do: 'Sells mock goods online.', problem_solved: 'Overcomplicated shopping.',
    }),
  },
  {
    key: 'target_market',
    tier: 'synthesis',
    gate: (ctx) => !!ctx.sections.about,
    prompt: (ctx) => `You are Phantom's audience strategist. Given this business profile and page copy, define the target market. This later drives 6 UGC "phantom" characters, so personas must feel like real, castable people.

Business profile: ${JSON.stringify(ctx.sections.about)}

Return ONLY JSON:
{
  "who_are_they": string,                                   // 1-2 sentences
  "primary_persona": { "name": string, "age_range": string, "description": string, "pain_points": [string] },
  "secondary_persona": { "name": string, "age_range": string, "description": string, "pain_points": [string] },
  "demographics": string                                    // concise summary
}

${pagesBlock(ctx)}`,
    schema: { type: 'json', required: ['who_are_they', 'primary_persona', 'secondary_persona', 'demographics'], shape: { primary_persona: 'object', secondary_persona: 'object' } },
    mock: JSON.stringify({
      who_are_they: 'Young online shoppers who value simplicity.',
      primary_persona: { name: 'Maya', age_range: '22-30', description: 'Urban professional, shops on IG.', pain_points: ['too many choices', 'no time'] },
      secondary_persona: { name: 'Jordan', age_range: '30-40', description: 'Busy parent, values reliability.', pain_points: ['quality anxiety'] },
      demographics: 'US urban, 22-40, mobile-first.',
    }),
  },
  {
    key: 'products_services',
    tier: 'extraction',
    gate: (ctx) => ctx.pages.some((p) => p.kind === 'products') || ctx.pages.length > 0,
    prompt: (ctx) => `Extract the product/service catalog for "${ctx.businessName}" from the pages below.

Return ONLY JSON:
{
  "segment": string,                 // "DTC" | "B2B" | "SaaS" | a combination
  "products": [ { "name": string, "description": string, "category": string } ],   // up to 12, [] if service business
  "services": [ { "description": string, "category": string, "tiers": string|null } ]  // [] if product business
}
Only items actually evidenced on the pages.

${pagesBlock(ctx)}`,
    schema: { type: 'json', required: ['segment', 'products', 'services'], shape: { products: 'array', services: 'array' } },
    mock: JSON.stringify({
      segment: 'DTC',
      products: [{ name: 'Mock Tee', description: 'A soft cotton tee.', category: 'apparel' }],
      services: [],
    }),
  },
  {
    key: 'brand_assets',
    tier: 'extraction',
    gate: (ctx) => ctx.pages.length > 0,
    prompt: (ctx) => `You are Phantom's brand analyst. From the page copy below, characterize the brand's voice and visual direction (this feeds design templates and content briefs).

Return ONLY JSON:
{
  "voice": { "tone_words": [string], "dos_donts": [string], "sample_copy": string },
  "visual": { "image_style": string, "color_hints": [string] }
}
tone_words: 3-6 adjectives. dos_donts: 3-6 imperative rules inferred from how they write. sample_copy: one representative sentence quoted or closely paraphrased from their pages. color_hints: any colors evidenced in copy/branding.

${pagesBlock(ctx)}`,
    schema: { type: 'json', required: ['voice', 'visual'], shape: { voice: 'object', visual: 'object' } },
    mock: JSON.stringify({
      voice: { tone_words: ['bold', 'warm'], dos_donts: ['Do speak plainly', "Don't use jargon"], sample_copy: 'Great products, zero fuss.' },
      visual: { image_style: 'clean studio shots, warm light', color_hints: ['black', 'cream'] },
    }),
  },
  {
    key: 'competitors',
    tier: 'synthesis',
    gate: (ctx) => !!ctx.sections.about && !!ctx.sections.products_services,
    prompt: (ctx) => `Identify 3-5 likely competitors of this business and how they operate. Use the business context below; where you rely on general knowledge rather than the scraped pages, keep confidence low.

Business: ${JSON.stringify(ctx.sections.about)}
Catalog: ${JSON.stringify(ctx.sections.products_services)}

Return ONLY JSON:
{
  "competitors": [ { "name": string, "how_they_operate": string, "social_presence": string, "primary_persona": string } ],
  "confidence": number               // 0-1: how grounded this is in the scraped evidence
}`,
    schema: { type: 'json', required: ['competitors', 'confidence'], shape: { competitors: 'array', confidence: 'number' } },
    mock: JSON.stringify({
      competitors: [{ name: 'RivalCo', how_they_operate: 'Discount-led DTC.', social_presence: 'Strong on TikTok.', primary_persona: 'Price-first shoppers' }],
      confidence: 0.4,
    }),
  },
  {
    key: 'vertical',
    tier: 'summary',
    gate: (ctx) => !!ctx.sections.about,
    prompt: (ctx) => `Classify this business into a Phantom content vertical and answer the vertical-specific questions (BPMN taxonomy-specific scrapes).

Business: ${JSON.stringify(ctx.sections.about)}
Catalog: ${JSON.stringify(ctx.sections.products_services || {})}
Tech hints: ${JSON.stringify(ctx.deterministic.tech)}

Return ONLY JSON:
{
  "vertical": "apparel" | "music_artist" | "other",
  "apparel": { "does_drops": boolean|null, "seasonal_drops": boolean|null, "year_round_sales": boolean|null, "shopify": boolean } | null,
  "music": { "listening_platforms": [string], "has_music_videos": boolean|null, "lyrics_available": boolean|null, "themes": [string], "genres": [string] } | null
}
Set the non-matching branch to null. shopify comes from the tech hints.`,
    schema: { type: 'json', required: ['vertical'] },
    mock: JSON.stringify({
      vertical: 'apparel',
      apparel: { does_drops: true, seasonal_drops: true, year_round_sales: false, shopify: true },
      music: null,
    }),
  },
];

// Assemble the final scrape.json — the Phase-3 script-gen input contract.
export function assembleScrape({ intake, deterministic, pages, sections, sources, flags, llmCalls, productImages = [] }) {
  return {
    version: 2,
    intake_id: intake.id,
    tenant_slug: intake.tenant_slug,
    business_name: intake.business_name,
    website: intake.website,
    scraped_at: new Date().toISOString(),
    about: sections.about || null,
    target_market: sections.target_market || null,
    products_services: sections.products_services || null,
    brand_assets: {
      ...(sections.brand_assets || {}),
      logo: deterministic.logo,
      images: deterministic.images,
      product_images: productImages,   // downloaded refs: [{asset_id, source_url, page_kind, bytes}]
      existing_media: { photos: deterministic.images.length, videos: 0, templates: 0 },
    },
    competitors: sections.competitors || null,
    vertical: sections.vertical || { vertical: 'other', apparel: null, music: null },
    social_media: {
      handles: deterministic.handles,
      sources,                       // per-platform status incl. blocked_needs_apify flags
      follower_buckets: FOLLOWER_BUCKETS,
    },
    crawl: {
      pages: pages.map((p) => ({ url: p.url, kind: p.kind, chars: p.text.length })),
      tech: deterministic.tech,
    },
    budget: { llm_calls: llmCalls },
    flags,
  };
}
