// lib/moments.js — the grounded "what's happening right now" feed for campaign
// ideation (weather / FIFA / world-event / business-event campaign types).
//
// Deliberately DETERMINISTIC, not LLM-invented: season math + a curated fixture
// list + operator extensions via $MOMENTS_JSON + business events from the scrape
// (drops, seasonal sales). The LLM's job is picking which moments fit the brand —
// never inventing that a tournament exists.
//
// MOMENTS_JSON example:
//   [{"key":"local-festival","label":"Neighborhood Night Market","from":"2026-07-10","to":"2026-07-12","angle":"local foot traffic"}]

const FIXTURES = [
  // Big sports/cultural windows (extend per year via MOMENTS_JSON)
  { key: 'fifa_wc_2026', label: 'FIFA World Cup 2026 (USA/Canada/Mexico)', from: '2026-06-11', to: '2026-07-19', type: 'fifa', angle: 'match-day energy, national pride, watch parties' },
  // Recurring US retail/cultural moments (month-day, any year)
  { key: 'july4', label: 'Independence Day', md: '07-04', span: 6, type: 'world_event', angle: 'summer, red-white-blue, cookouts' },
  { key: 'back_to_school', label: 'Back to School', md: '08-15', span: 21, type: 'world_event', angle: 'fresh starts, routines' },
  { key: 'halloween', label: 'Halloween', md: '10-31', span: 14, type: 'world_event', angle: 'costumes, playful spooky' },
  { key: 'bfcm', label: 'Black Friday / Cyber Monday', md: '11-27', span: 10, type: 'world_event', angle: 'deals, urgency, gift guides' },
  { key: 'holidays', label: 'Holiday Season', md: '12-15', span: 20, type: 'world_event', angle: 'gifting, cozy, year-end' },
  { key: 'new_year', label: 'New Year', md: '01-01', span: 10, type: 'world_event', angle: 'resolutions, resets' },
  { key: 'valentines', label: "Valentine's Day", md: '02-14', span: 10, type: 'world_event', angle: 'gifts, date night' },
  { key: 'mothers_day', label: "Mother's Day", md: '05-10', span: 10, type: 'world_event', angle: 'gifting, appreciation' },
];

function seasonFor(date, location = '') {
  const m = date.getUTCMonth() + 1;
  const southern = /australia|new zealand|argentina|chile|south africa|brazil|peru|uruguay/i.test(location);
  const north = m >= 6 && m <= 8 ? 'summer' : m >= 3 && m <= 5 ? 'spring' : m >= 9 && m <= 11 ? 'fall' : 'winter';
  const flip = { summer: 'winter', winter: 'summer', spring: 'fall', fall: 'spring' };
  return southern ? flip[north] : north;
}

function inWindow(now, from, to) {
  return now >= new Date(from + 'T00:00:00Z') && now <= new Date(to + 'T23:59:59Z');
}

// Active or starting within `horizonDays`.
export function activeMoments({ now = new Date(), horizonDays = 35, location = '', scrape = null } = {}) {
  const out = [];
  const horizon = new Date(now.getTime() + horizonDays * 86400_000);
  const year = now.getUTCFullYear();

  const windows = [];
  for (const f of FIXTURES) {
    if (f.from && f.to) windows.push(f);
    else if (f.md) {
      for (const y of [year, year + 1]) {
        const center = new Date(`${y}-${f.md}T12:00:00Z`);
        const half = (f.span || 7) * 86400_000 / 2;
        windows.push({ ...f, from: new Date(center.getTime() - half).toISOString().slice(0, 10), to: new Date(center.getTime() + half).toISOString().slice(0, 10) });
      }
    }
  }
  try {
    for (const m of JSON.parse(process.env.MOMENTS_JSON || '[]')) {
      if (m.from && m.to) windows.push({ type: 'world_event', angle: '', ...m });
    }
  } catch { /* bad MOMENTS_JSON → ignore */ }

  for (const w of windows) {
    const startsSoon = new Date(w.from + 'T00:00:00Z') <= horizon && new Date(w.to + 'T00:00:00Z') >= now;
    if (inWindow(now, w.from, w.to) || startsSoon) {
      out.push({ key: w.key, label: w.label, type: w.type, from: w.from, to: w.to, angle: w.angle, active: inWindow(now, w.from, w.to) });
    }
  }

  out.push({ key: 'season', label: `${seasonFor(now, location)} season`, type: 'weather', active: true, angle: `${seasonFor(now, location)} settings, wardrobe, activities` });

  // Business events straight from the scrape (apparel drops etc.)
  const ap = scrape?.vertical?.apparel;
  if (ap?.does_drops) out.push({ key: 'drop', label: 'Product drop cycle', type: 'business_event', active: true, angle: ap.seasonal_drops ? 'seasonal drop tease → launch → sellout' : 'drop tease → launch → sellout' });
  if (ap?.year_round_sales) out.push({ key: 'evergreen_sale', label: 'Year-round promotions', type: 'business_event', active: true, angle: 'offer-led hooks' });

  return out;
}
