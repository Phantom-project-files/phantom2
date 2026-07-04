// lib/scriptgen/scrape-loader.js — shared scrape.json loader (valueprop + scriptgen).
import fs from 'fs';
import path from 'path';
import { storage } from '../storage.js';

export async function loadScrapeDoc(intake) {
  if (!intake?.scrape_key) return null;
  try {
    if (storage.backend === 'local') {
      const fp = path.join(storage.localRoot, intake.scrape_key);
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
    const url = await storage.signedGet(intake.tenant_slug, intake.scrape_key, 120);
    const r = await fetch(url);
    return await r.json();
  } catch {
    return null;
  }
}
