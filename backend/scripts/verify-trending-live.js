// scripts/verify-trending-live.js — confirm the Instagram Audio API creds work.
// Run AFTER setting IG_AUDIO_ACCESS_TOKEN + IG_AUDIO_USER_ID in .env:
//   node scripts/verify-trending-live.js
// Hits the real ig_audio endpoint (no writes, no library changes) and prints the
// trending sounds it can see, or the exact Graph API error so you can fix scopes.
import 'dotenv/config';
import * as trending from '../lib/edit/trending.js';

if (trending.isMock()) {
  console.log('IG audio is in MOCK mode — nothing to verify live.');
  console.log('Set IG_AUDIO_ACCESS_TOKEN + IG_AUDIO_USER_ID (or IG_AUDIO_MODE=live) in .env, then re-run.');
  process.exit(1);
}

try {
  const items = await trending.fetchTrending({ audioType: 'music', limit: 5 });
  if (!items.length) {
    console.log('LIVE ok but 0 trending items returned — check the account is a professional IG account in a supported region.');
    process.exit(1);
  }
  console.log(`LIVE ✅ — ig_audio returned ${items.length} trending sound(s):`);
  for (const it of items) {
    console.log(`  · "${it.title}"${it.artist ? ' by ' + it.artist : ''}` +
      ` — ads_eligible=${it.ads_eligible}, downloadable=${!!it.download_url}, find=${it.source_url || 'n/a'}`);
  }
  const usable = items.filter((i) => i.download_url).length;
  console.log(`\n${usable}/${items.length} have a preview download_url (needed to cut + preview).`);
  console.log('If that looks right, run the sync:  POST /api/admin/audio/sync-trending {"ads_only":true}');
  process.exit(0);
} catch (err) {
  console.log('LIVE ❌ —', err.message);
  console.log('\nCommon fixes:');
  console.log('  · token expired → generate a fresh long-lived / System User token');
  console.log('  · missing scope → token needs instagram_basic + instagram_content_publish');
  console.log('  · wrong user_id → must be the IG *professional* account id, not the FB page id');
  process.exit(1);
}
