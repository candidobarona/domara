// update_schedule.js: Node 20+, zero dependencies.
// Discovers every active sport/competition in The Odds API, fetches its upcoming events, writes events.json.
// The key comes from the ODDS_API_KEY environment variable (GitHub Secret) and is never written to any file.
const fs = require('fs');
const API_KEY = process.env.ODDS_API_KEY;
const BASE = 'https://api.the-odds-api.com/v4';
const BATCH = 10; // requests in flight at once (Promise.allSettled per batch)
if (!API_KEY) { console.error('❌ ODDS_API_KEY is not set. Add it under Settings → Secrets and variables → Actions.'); process.exit(1); }

const quota = { first: null, remaining: '?', used: '?' };
async function api(path, params = '') {
  const r = await fetch(`${BASE}${path}?apiKey=${API_KEY}${params}`, { signal: AbortSignal.timeout(20000) });
  quota.remaining = r.headers.get('x-requests-remaining') ?? quota.remaining;
  quota.used = r.headers.get('x-requests-used') ?? quota.used;
  if (quota.first === null) quota.first = quota.remaining;
  if (!r.ok) {
    let m = ''; try { m = (await r.json()).message || ''; } catch {}
    throw new Error(`HTTP ${r.status}${m ? ' - ' + m : ''}`); // the key is never part of an error message
  }
  return r.json();
}

(async () => {
  // 1) Full catalog of currently active sports/competitions
  let sports;
  try { sports = await api('/sports/'); } catch (e) { console.error('❌ Could not load the sports catalog: ' + e.message); process.exit(1); }
  const list = sports.filter((s) => s.active && !s.has_outrights); // outright/futures markets have no fixtures
  console.log(`Catalog: ${sports.length} sports returned, ${list.length} active with fixtures\n`);

  // 2) /events for each one, in small batches; one failure never stops the rest
  const results = [];
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const settled = await Promise.allSettled(chunk.map((s) => api(`/sports/${s.key}/events`, '&dateFormat=iso')));
    settled.forEach((r, k) => {
      const s = chunk[k], base = { key: s.key, title: s.title, group: s.group, count: 0, status: 'ok', note: '', ev: [] };
      if (r.status === 'rejected') return results.push({ ...base, status: 'error', note: r.reason.message });
      const ev = r.value.filter((x) => x.id && x.commence_time && !isNaN(new Date(x.commence_time))).map((x) => ({
        id: x.id, sport_key: s.key, sport_title: x.sport_title || s.title, group: s.group,
        home_team: x.home_team || '', away_team: x.away_team || '',
        title: x.home_team && x.away_team ? `${x.home_team} vs ${x.away_team}` : x.home_team || x.away_team || s.title,
        commence_time: new Date(x.commence_time).toISOString(),
      }));
      results.push({ ...base, count: ev.length, status: ev.length ? 'ok' : 'empty', ev });
    });
  }

  // 3) Verification report
  results.sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
  for (const r of results) {
    const icon = { ok: '✅', empty: '⚠️ ', error: '❌' }[r.status];
    console.log(`${icon} ${r.group} › ${r.title}: ${r.count} events` + (r.status === 'empty' ? ' (none scheduled)' : '') + (r.note ? ` [${r.note}]` : ''));
  }
  const used = quota.first != null && !isNaN(quota.first - quota.remaining) ? ` (this run used ~${quota.first - quota.remaining})` : '';
  console.log(`\n📊 API quota: ${quota.remaining} remaining${used}`);

  const seen = new Set();
  const events = results.flatMap((r) => r.ev).filter((e) => !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  const groups = new Set(events.map((e) => e.group)), comps = new Set(events.map((e) => e.sport_key));
  console.log(`Total: ${events.length} events across ${comps.size} competitions in ${groups.size} categories`);
  if (!events.length) { console.error('No events fetched. Keeping the previous events.json.'); process.exit(1); }

  const report = results.map(({ ev, ...r }) => r);
  fs.writeFileSync('events.json', `{"generated":${JSON.stringify(new Date().toISOString())},"report":${JSON.stringify(report)},"events":[\n${events.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`);
  console.log('Wrote events.json');
})();
