// update_schedule.js: Node 20+, zero dependencies.
// Reads ODDS_API_KEY from the environment (GitHub Secret), queries The Odds API v4 and writes events.json.
const fs = require('fs');
const API_KEY = process.env.ODDS_API_KEY;
const BASE = 'https://api.the-odds-api.com/v4';
if (!API_KEY) { console.error('❌ ODDS_API_KEY is not set. Add it under Settings → Secrets and variables → Actions.'); process.exit(1); }

// [id, display name, The Odds API sport_key]
const C = [
  ['laliga', 'LaLiga', 'soccer_spain_la_liga'],
  ['pl', 'Premier League', 'soccer_epl'],
  ['sa', 'Serie A', 'soccer_italy_serie_a'],
  ['l1', 'Ligue 1', 'soccer_france_ligue_one'],
  ['bl', 'Bundesliga', 'soccer_germany_bundesliga'],
  ['pt', 'Liga Portugal', 'soccer_portugal_primeira_liga'],
  ['ucl', 'Champions League', 'soccer_uefa_champs_league'],
  ['uel', 'Europa League', 'soccer_uefa_europa_league'],
  ['unl', 'Nations League', 'soccer_uefa_nations_league'],
  ['arg', 'Liga Argentina', 'soccer_argentina_primera_division'],
  ['bra', 'Brasileirão', 'soccer_brazil_campeonato'],
  ['nba', 'NBA', 'basketball_nba'],
  ['nfl', 'NFL', 'americanfootball_nfl'],
  ['rwc', 'Rugby World Cup', 'rugbyunion_world_cup'],
  ['6n', 'Six Nations', 'rugbyunion_six_nations'],
  ['trc', 'Rugby Championship', 'rugbyunion_rugby_championship'],
  ['nc', 'Nations Championship', 'rugbyunion_international'],
];

const quota = { remaining: '?', used: '?' };
async function api(path, params = '') {
  const r = await fetch(`${BASE}${path}?apiKey=${API_KEY}${params}`, { signal: AbortSignal.timeout(20000) });
  quota.remaining = r.headers.get('x-requests-remaining') ?? quota.remaining;
  quota.used = r.headers.get('x-requests-used') ?? quota.used;
  if (!r.ok) {
    let m = ''; try { m = (await r.json()).message || ''; } catch {}
    throw new Error(`HTTP ${r.status}${m ? ' - ' + m : ''}`); // the key is never included in messages
  }
  return r.json();
}

(async () => {
  // 1) Which sport_keys are active right now? (this call does not return fixtures)
  let sports;
  try { sports = await api('/sports/'); } catch (e) { console.error('❌ Could not list sports: ' + e.message); process.exit(1); }
  const active = new Set(sports.filter((s) => s.active).map((s) => s.key));
  console.log(`The Odds API: ${active.size} active sport keys\n`);

  // 2) /events: teams + commence_time only
  const results = await Promise.all(C.map(async ([id, name, key]) => {
    const base = { id, name, key, count: 0, status: 'ok', note: '', ev: [] };
    if (!active.has(key)) return { ...base, status: 'inactive', note: 'sport_key not active right now (off-season or not offered)' };
    try {
      const j = await api(`/sports/${key}/events`, '&dateFormat=iso');
      const ev = j.map((x) => ({ c: id, s: new Date(x.commence_time), title: `${x.home_team} vs ${x.away_team}` }))
        .filter((e) => !isNaN(e.s) && e.title.indexOf('undefined') < 0).map((e) => ({ ...e, s: e.s.toISOString() }));
      return { ...base, count: ev.length, status: ev.length ? 'ok' : 'empty', ev };
    } catch (e) { return { ...base, status: 'error', note: e.message }; }
  }));

  for (const r of results) {
    const icon = { ok: '✅', empty: '⚠️ ', inactive: '⚠️ ', error: '❌' }[r.status];
    const tail = r.status === 'empty' ? ' (off-season or none scheduled)' : r.status === 'inactive' ? ` (${r.key} not active)` : r.note ? ` [${r.note}]` : '';
    console.log(`${icon} ${r.name}: ${r.count} events${tail}`);
    if (r.status === 'inactive' && !r.key.startsWith('soccer_')) {
      const same = [...active].filter((k) => k.startsWith(r.key.split('_')[0] + '_'));
      if (same.length) console.log(`     active ${r.key.split('_')[0]} keys: ${same.join(', ')}`);
    }
  }
  console.log(`\n📊 API quota: ${quota.remaining} remaining (${quota.used} used)`);

  const seen = new Set();
  const events = results.flatMap((r) => r.ev).filter((e) => { const k = e.c + e.s + e.title; return seen.has(k) ? false : seen.add(k); })
    .sort((a, b) => a.s.localeCompare(b.s));
  console.log(`Total: ${events.length} events`);
  if (!events.length) { console.error('No events fetched. Keeping the previous events.json.'); process.exit(1); }
  const report = results.map(({ ev, key, ...r }) => ({ ...r, src: key }));
  fs.writeFileSync('events.json', JSON.stringify({ generated: new Date().toISOString(), report, events }, null, 1));
  console.log('Wrote events.json');
})();
