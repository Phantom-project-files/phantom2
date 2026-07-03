// lib/tiers.js — pricing source of truth (BPMN sheet numbers).
// One module imported by plans UI (/api/tiers), payments, script-gen fanout (Phase 3).

export const TIERS = ['standard', 'premium', 'ultra', 'overkill'];

// { price USD, recurring, content counts } — Overkill is 100/140 per the BPMN
// (v1 had drifted to 100/200; the sheet wins).
export const TIER_CONFIG = {
  standard: { price: 800, recurring: false, reels: 30, posts: 30, deploy: false },
  premium: { price: 1000, recurring: true, reels: 30, posts: 30, deploy: true },
  ultra: { price: 2000, recurring: true, reels: 60, posts: 90, deploy: true },
  overkill: { price: 4000, recurring: true, reels: 100, posts: 140, deploy: true },
};

// Posts pillar split at script-gen time (v1-proven ratios).
export const PILLAR_SPLIT = { product: 0.40, brand: 0.25, educational: 0.20, lifestyle: 0.15 };

export const TIER_DISPLAY = {
  standard: {
    name: 'Standard', tagline: 'One-time creative drop',
    price_label: '$800 one-time',
    bullets: ['30 reels · 30 posts', '6 brand-built Phantoms', 'Human QC on every piece', 'Download ZIP or per-piece'],
    badge: null,
  },
  premium: {
    name: 'Premium', tagline: 'A post and a reel, every day',
    price_label: '$1,000 / month',
    bullets: ['30 reels · 30 posts monthly', '1 reel + 1 post deployed daily', 'Connect your socials — we publish', 'Month-end report + learnings'],
    badge: 'Recommended',
  },
  ultra: {
    name: 'Ultra', tagline: 'Own the feed',
    price_label: '$2,000 / month',
    bullets: ['60 reels · 90 posts monthly', 'Multi-daily deploy calendar', 'Everything in Premium', 'Priority regeneration'],
    badge: null,
  },
  overkill: {
    name: 'Overkill', tagline: 'Full-channel domination',
    price_label: '$4,000 / month',
    bullets: ['100 reels · 140 posts monthly', 'Everything in Ultra', 'Campaign clusters across events', 'White-glove QC turnaround'],
    badge: null,
  },
};

export const isValidTier = (t) => TIERS.includes(t);
export const tierConfig = (t) => TIER_CONFIG[t] || null;
