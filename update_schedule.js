// update_schedule.js: Node 20+, zero dependencies.
// Fetches ONLY the competitions listed in TARGETS from The Odds API and writes events.json.
// The key comes from the ODDS_API_KEY environment variable (GitHub Secret) and is never written to any file.
const fs = require('fs');
const API_KEY = process.env.ODDS_API_KEY;
const BASE = 'https://api.the-odds-api.com/v4';
if (!API_KEY) { console.error('❌ ODDS_API_KEY is not set. Add it under Settings → Secrets and variables → Actions.'); process.exit(1); }

// keys = exact sport_key candidates (first active one wins). re = fallback matched against key + title in the live catalog.
// group = forced category; otherwise the API group is used with Soccer → Football and Rugby Union → Rugby.
const TARGETS = [
  { name: 'NFL', keys: ['americanfootball_nfl'], re: /americanfootball_nfl$/i, group: 'American Football' },
  { name: 'NBA', keys: ['basketball_nba'], re: /basketball_nba$/i, group: 'Basketball' },
  { name: 'Euroleague', keys: ['basketball_euroleague'], re: /basketball_euroleague/i, group: 'Basketball' },
  { name: 'International Twenty20', keys: ['cricket_international_t20'], re: /cricket_international_t20/i, group: 'Cricket' },
  { name: 'Championship', keys: ['soccer_efl_champ'], re: /^soccer_efl_champ/i },
  { name: 'Brazil Série A', keys: ['soccer_brazil_campeonato'], re: /brazil.*(serie|campeonato)/i },
  { name: 'Bundesliga', keys: ['soccer_germany_bundesliga'], re: /germany_bundesliga$/i },
  { name: 'Champions League', keys: ['soccer_uefa_champs_league', 'soccer_uefa_champions_league'], re: /uefa.*champ/i },
  { name: 'Copa Libertadores', keys: ['soccer_conmebol_copa_libertadores'], re: /libertadores/i },
  { name: 'Copa Sudamericana', keys: ['soccer_conmebol_copa_sudamericana'], re: /sudamericana/i },
  { name: 'La Liga - Spain', keys: ['soccer_spain_la_liga'], re: /spain_la_liga$/i },
  { name: 'Ligue 1 - France', keys: ['soccer_france_ligue_one'], re: /france_ligue_one$/i },
  { name: 'Primera División', keys: ['soccer_argentina_primera_division'], re: /argentina.*primera/i },
  { name: 'Serie A - Italy', keys: ['soccer_italy_serie_a'], re: /italy_serie_a$/i },
  { name: 'UEFA Europa League', keys: ['soccer_uefa_europa_league'], re: /uefa.*europa_league$/i },
  { name: 'Six Nations', keys: ['rugbyunion_six_nations'], re: /six_nations/i, group: 'Rugby' },
];
const normGroup = (g) => (/soccer|football$/i.test(g) && !/american/i.test(g) ? 'Football' : /rugby/i.test(g) ? 'Rugby' : g);

const quota = { first: null, remaining: '?' };
async function api(path, params = '') {
  const r = await fetch(`${BASE}${path}?apiKey=${API_KEY}${params}`, { signal: AbortSignal.timeout(20000) });
  quota.remaining = r.headers.get('x-requests-remaining') ?? quota.remaining;
  if (quota.first === null) quota.first = quota.remaining;
  if (!r.ok) {
    let m = ''; try { m = (await r.json()).message || ''; } catch {}
    throw new Error(`HTTP ${r.status}${m ? ' - ' + m : ''}`); // the key is never part of an error message
  }
  return r.json();
}

(async () => {
  // 1) Catalog (including inactive entries, so we can tell "off-season" from "unknown key")
  let catalog;
  try { catalog = await api('/sports/', '&all=true'); } catch (e) { console.error('❌ Could not load the sports catalog: ' + e.message); process.exit(1); }
  const byKey = new Map(catalog.map((s) => [s.key, s]));
  const usable = (s) => s.active && !s.has_outrights;

  // 2) Resolve each target to real sport_keys
  const jobs = [], report = [], used = new Set();
  for (const t of TARGETS) {
    let hits = t.keys.map((k) => byKey.get(k)).filter(Boolean);
    if (!hits.some(usable) && t.re) { const m = catalog.filter((s) => usable(s) && t.re.test(`${s.key} ${s.title}`)); if (m.length) hits = t.all ? m : m.slice(0, 1); }
    const act = (t.all ? hits : hits.slice(0, 1)).filter(usable).filter((s) => !used.has(s.key));
    if (!hits.length) { console.log(`⚠️  ${t.name}: not found in The Odds API catalog, skipped`); report.push({ key: '', title: t.name, group: t.group || '', count: 0, status: 'missing', note: 'not found in catalog' }); continue; }
    if (!hits.some(usable)) { console.log(`⚠️  ${t.name}: ${hits[0].key} is not active right now (off-season), skipped`); report.push({ key: hits[0].key, title: hits[0].title, group: t.group || normGroup(hits[0].group), count: 0, status: 'inactive', note: 'not active right now' }); continue; }
    for (const s of act) { used.add(s.key); jobs.push({ s, group: t.group || normGroup(s.group) }); }
  }

  // 3) /events for the resolved keys only (failures are isolated)
  const settled = await Promise.allSettled(jobs.map(({ s }) => api(`/sports/${s.key}/events`, '&dateFormat=iso')));
  const events = [];
  settled.forEach((r, i) => {
    const { s, group } = jobs[i], base = { key: s.key, title: s.title, group };
    if (r.status === 'rejected') { console.log(`❌ ${group} › ${s.title}: ${r.reason.message}`); return report.push({ ...base, count: 0, status: 'error', note: r.reason.message }); }
    const ev = r.value.filter((x) => x.id && x.commence_time && !isNaN(new Date(x.commence_time))).map((x) => ({
      id: x.id, sport_key: s.key, sport_title: x.sport_title || s.title, group,
      home_team: x.home_team || '', away_team: x.away_team || '',
      title: x.home_team && x.away_team ? `${x.home_team} vs ${x.away_team}` : x.home_team || x.away_team || s.title,
      commence_time: new Date(x.commence_time).toISOString(),
    }));
    console.log(`${ev.length ? '✅' : '⚠️ '} ${group} › ${s.title}: ${ev.length} events${ev.length ? '' : ' (none scheduled)'}`);
    events.push(...ev); report.push({ ...base, count: ev.length, status: ev.length ? 'ok' : 'empty', note: '' });
  });

  const spent = quota.first != null && !isNaN(quota.first - quota.remaining) ? ` (this run used ~${quota.first - quota.remaining})` : '';
  console.log(`\n📊 API quota: ${quota.remaining} remaining${spent}`);
  const seen = new Set(), unique = events.filter((e) => !seen.has(e.id) && seen.add(e.id)).sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  console.log(`Total: ${unique.length} events (${events.length - unique.length} duplicates removed)`);
  if (!unique.length) { console.error('No events fetched. Keeping the previous events.json.'); process.exit(1); }
  fs.writeFileSync('events.json', `{"generated":${JSON.stringify(new Date().toISOString())},"report":${JSON.stringify(report)},"events":[\n${unique.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`);
  console.log('Wrote events.json');
})();
