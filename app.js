'use strict';

// ──────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';
const TZ = 1; // Tunisia = UTC+1

// flagcdn ISO2 map
const FL = {"Mexico":"mx","South Africa":"za","South Korea":"kr","Korea Republic":"kr","Czech Republic":"cz","Czechia":"cz","Canada":"ca","Bosnia-Herzegovina":"ba","Bosnia and Herzegovina":"ba","United States":"us","USA":"us","Paraguay":"py","Qatar":"qa","Switzerland":"ch","Brazil":"br","Morocco":"ma","Haiti":"ht","Scotland":"gb-sct","Australia":"au","Turkey":"tr","Türkiye":"tr","Germany":"de","Curaçao":"cw","Curacao":"cw","Netherlands":"nl","Japan":"jp","Côte d'Ivoire":"ci","Ivory Coast":"ci","Ecuador":"ec","Sweden":"se","Tunisia":"tn","Spain":"es","Cape Verde":"cv","Cabo Verde":"cv","Belgium":"be","Egypt":"eg","Saudi Arabia":"sa","Uruguay":"uy","Iran":"ir","New Zealand":"nz","France":"fr","Senegal":"sn","Iraq":"iq","Norway":"no","Argentina":"ar","Algeria":"dz","Austria":"at","Jordan":"jo","Ghana":"gh","Panama":"pa","England":"gb-eng","Croatia":"hr","Portugal":"pt","DR Congo":"cd","Congo DR":"cd","Uzbekistan":"uz","Colombia":"co","Wales":"gb-wls","Serbia":"rs","Denmark":"dk","Poland":"pl","Ukraine":"ua"};

// Canonicalize team names that differ between ESPN endpoints (schedule vs standings vs leaders)
const NAME_ALIAS = {
  'Korea Republic':'South Korea','Czech Republic':'Czechia','Turkey':'Türkiye',
  'Curacao':'Curaçao',"Côte d'Ivoire":'Ivory Coast','Cape Verde':'Cabo Verde',
  'Bosnia-Herzegovina':'Bosnia and Herzegovina','DR Congo':'Congo DR','USA':'United States',
};
function canon(name) { return NAME_ALIAS[name] || name; }

// ──────────────────────────────────────────
// STATE
// ──────────────────────────────────────────
let MATCHES = [];      // [{home,away,utcDate,timeStr,dateStr,venue,round,suit,lk,isFinal}]
let SCORES  = {};      // lk → {status,homeScore,awayScore,clock,isPaused}
let STANDINGS = null;  // parsed group standings
let STANDINGS_POS = {}; // team name → "2nd in Group F" tag string
let GOLDENBOOT = null; // cached top scorers
let lastUpdate = null;
let refreshTimer = null;
let activeFilter = 'all';
let searchQuery = '';
let useLocalTZ = false; // false = Tunisia time, true = browser local time
let favorites = new Set(); // team names starred by user
const FAVORITES_KEY = 'wc2026_favorites';

// ── PiP (floating live score widget) ──
let PIP_LK = null;        // lk of the currently pinned match, or null
let PIP_DISMISSED = false; // user explicitly closed the PiP this session

// ──────────────────────────────────────────
// UTILS
// ──────────────────────────────────────────
function tunTime(utc) {
  const d = new Date(utc);
  const h = (d.getUTCHours() + TZ) % 24;
  const m = d.getUTCMinutes();
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function tunDate(utc) {
  const d = new Date(new Date(utc).getTime() + TZ * 3600000);
  return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
}
function todayTun() {
  return tunDate(Date.now());
}
// Display time/date — respects the local-time toggle
function displayTime(utc) {
  if (!useLocalTZ) return tunTime(utc);
  const d = new Date(utc);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function displayDateLabel(utc) {
  if (!useLocalTZ) return tunDate(utc);
  return new Date(utc).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
}
function todayDisplay() {
  return displayDateLabel(Date.now());
}
function suit(utc) {
  const h = (new Date(utc).getUTCHours() + TZ) % 24;
  if (h >= 15 && h <= 23) return {cls:'green', label:'Good time', icon:'🟢'};
  if (h === 0 || (h >= 12 && h < 15)) return {cls:'yellow', label:'Borderline', icon:'🟡'};
  return {cls:'red', label:'Rough hours', icon:'🔴'};
}
function isTN(m) { return /tunisia/i.test(m.home + m.away); }
function lk(h, a) { return (h + '|' + a).toLowerCase(); }

function flagImg(name, extraClass) {
  const code = FL[name];
  const cls = extraClass ? ` ${extraClass}` : '';
  if (!code) return `<span class="flag-fb${cls}" style="width:28px;height:21px">${name.slice(0,2).toUpperCase()}</span>`;
  const ini = name.slice(0,2).toUpperCase();
  return `<img class="${extraClass||''}" src="https://flagcdn.com/w40/${code}.webp" width="28" height="21" alt="${name}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'flag-fb${cls}',textContent:'${ini}',style:'width:28px;height:21px'}))">`;
}

function gcalUrl(m) {
  const s = new Date(m.utcDate).toISOString().replace(/[-:.]/g,'').slice(0,15)+'Z';
  const e = new Date(new Date(m.utcDate).getTime()+7200000).toISOString().replace(/[-:.]/g,'').slice(0,15)+'Z';
  const t = m.isFinal ? '🏆 WC 2026 Final' : `WC 2026: ${m.home} vs ${m.away}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(t)}&dates=${s}/${e}&location=${encodeURIComponent(m.venue)}`;
}

// Build a single VEVENT block (no BEGIN/END:VCALENDAR wrapper)
function buildVEvent(m, idx) {
  const fmt = u => new Date(new Date(u).getTime()+TZ*3600000).toISOString().replace(/[-:.Z]/g,'').slice(0,15);
  const t = m.isFinal ? '🏆 FIFA World Cup 2026 Final' : `FIFA WC 2026: ${m.home} vs ${m.away}`;
  return [
    'BEGIN:VEVENT',
    `UID:wc26-${idx}-${fmt(m.utcDate)}@tn`,
    `DTSTART;TZID=Africa/Tunis:${fmt(m.utcDate)}`,
    `DTEND;TZID=Africa/Tunis:${fmt(new Date(new Date(m.utcDate).getTime()+7200000))}`,
    `SUMMARY:${t}`,`LOCATION:${m.venue}`,
    `DESCRIPTION:${m.round} | ${m.suit.icon} ${m.suit.label}`,
    'END:VEVENT'
  ].join('\r\n');
}

function dlIcs(idx) {
  const m = MATCHES[idx];
  const t = m.isFinal ? '🏆 FIFA World Cup 2026 Final' : `FIFA WC 2026: ${m.home} vs ${m.away}`;
  const blob = new Blob([[
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//WC2026//EN',
    buildVEvent(m, idx),
    'END:VCALENDAR'
  ].join('\r\n')], {type:'text/calendar'});
  Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:t.replace(/[^\w]/g,'_')+'.ics'}).click();
}

// Bulk export — all matches, or Tunisia-only
function exportAllIcs(tunisiaOnly) {
  if (!MATCHES.length) return;
  const items = MATCHES
    .map((m,i) => ({m,i}))
    .filter(({m}) => m.home !== 'TBD' && (!tunisiaOnly || isTN(m)));

  if (!items.length) {
    alert(tunisiaOnly ? 'No Tunisia matches to export yet.' : 'No matches to export yet.');
    return;
  }

  const body = items.map(({m,i}) => buildVEvent(m,i)).join('\r\n');
  const blob = new Blob([[
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//WC2026//EN',
    body,
    'END:VCALENDAR'
  ].join('\r\n')], {type:'text/calendar'});

  const filename = tunisiaOnly ? 'WC2026_Tunisia_matches.ics' : 'WC2026_all_matches.ics';
  Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:filename}).click();
}

// ── SHARE ──
function shareSchedule() {
  const text = '🏆 FIFA World Cup 2026 schedule in Tunisia time — live scores, standings & calendar reminders';
  const url = window.location.href;
  if (navigator.share) {
    navigator.share({title:'FIFA World Cup 2026 · Tunisia Time', text, url}).catch(()=>{});
  } else {
    navigator.clipboard?.writeText(url).then(() => {
      const btn = document.activeElement;
      if (btn && btn.classList.contains('tool-btn')) {
        const orig = btn.textContent;
        btn.textContent = '✓ Link copied';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }
    }).catch(() => alert('Copy this link: ' + url));
  }
}

// ── TIMEZONE TOGGLE ──
function toggleTZ() {
  useLocalTZ = !useLocalTZ;
  document.getElementById('tzBtn').textContent = useLocalTZ ? '🇹🇳 Tunisia time' : '🌍 Local time';
  renderCurrent();
}

// ── SEARCH ──
function onSearchInput() {
  searchQuery = document.getElementById('searchInput').value.trim().toLowerCase();
  document.getElementById('searchClear').style.display = searchQuery ? '' : 'none';
  renderCurrent();
}
function clearSearch() {
  document.getElementById('searchInput').value = '';
  searchQuery = '';
  document.getElementById('searchClear').style.display = 'none';
  renderCurrent();
}
function matchesSearch(m) {
  if (!searchQuery) return true;
  return m.home.toLowerCase().includes(searchQuery) || m.away.toLowerCase().includes(searchQuery) || m.venue.toLowerCase().includes(searchQuery) || m.round.toLowerCase().includes(searchQuery);
}

// ── FAVORITES ──
function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (raw) favorites = new Set(JSON.parse(raw));
  } catch(e) { /* ignore */ }
}
function saveFavorites() {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); } catch(e) {}
}
// A "favorite match" = either team is starred
function isFavoriteMatch(m) {
  return favorites.has(m.home) || favorites.has(m.away);
}
function toggleFavoriteMatch(idx) {
  const m = MATCHES[idx];
  const bothFav = favorites.has(m.home) && favorites.has(m.away);
  if (bothFav) {
    favorites.delete(m.home); favorites.delete(m.away);
  } else {
    favorites.add(m.home); favorites.add(m.away);
  }
  saveFavorites();
  renderCurrent();
}

// ──────────────────────────────────────────
// STATUS UI
// ──────────────────────────────────────────
function setStatus(type, msg) {
  document.getElementById('apiDot').className = 'api-dot ' + {ok:'d-ok',loading:'d-spin',err:'d-err'}[type];
  document.getElementById('apiTxt').textContent = msg;
}

// ──────────────────────────────────────────
// ESPN FETCH – FULL SCHEDULE
// ──────────────────────────────────────────
async function fetchSchedule() {
  setStatus('loading','Loading…');
  try {
    // Fetch all WC dates in one call
    const r = await fetch(`${ESPN_BASE}/scoreboard?dates=20260611-20260719&limit=120`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const events = data.events || [];
    if (!events.length) throw new Error('No events returned');
    parseSchedule(events);
    setStatus('ok', `ESPN · ${MATCHES.length} matches`);
    document.getElementById('hdr-sub').textContent = `All times UTC+1 · ${MATCHES.length} matches · auto-refresh 60s`;
  } catch(err) {
    console.warn('ESPN schedule failed:', err.message, '→ static fallback');
    useStaticFallback();
    setStatus('err','Fallback schedule · ESPN blocked server-side');
  }
}

function parseSchedule(events) {
  MATCHES = events.map(ev => {
    const comp   = ev.competitions?.[0] || {};
    const comps  = comp.competitors || [];
    const home   = comps.find(c => c.homeAway === 'home') || comps[0] || {};
    const away   = comps.find(c => c.homeAway === 'away') || comps[1] || {};
    const hName  = home.team?.displayName || 'TBD';
    const aName  = away.team?.displayName || 'TBD';
    const utcDate = ev.date;
    const s = suit(utcDate);
    // Round label: try notes, then season type
    const note = comp.notes?.[0]?.headline || '';
    const round = note || comp.type?.abbreviation || ev.season?.type?.name || 'Group Stage';
    const isF = /\bfinal\b/i.test(round) && !/semi|quarter/i.test(round);
    const isKO = /round|quarter|semi|final/i.test(round);
    return {
      id: ev.id,
      home: hName, away: aName,
      utcDate,
      timeStr: tunTime(utcDate),
      dateStr: tunDate(utcDate),
      venue: comp.venue?.fullName || 'USA',
      round, suit: s, lk: lk(hName, aName),
      isFinal: isF, isKO,
      // Absorb scores from schedule response too
      homeScore: home.score ?? null,
      awayScore: away.score ?? null,
      status: comp.status?.type?.name || 'STATUS_SCHEDULED',
      clock: comp.status?.displayClock || '',
    };
  }).sort((a,b) => new Date(a.utcDate) - new Date(b.utcDate));

  // Pre-populate SCORES from schedule response
  MATCHES.forEach(m => {
    if (m.status !== 'STATUS_SCHEDULED' && m.homeScore !== null) {
      SCORES[m.lk] = {
        status: m.status,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        clock: m.clock,
        isPaused: m.status === 'STATUS_HALFTIME',
      };
    }
  });

  updateStats();
  renderCurrent();
  renderPip();
}

// ──────────────────────────────────────────
// ESPN FETCH – LIVE SCORES (today only)
// ──────────────────────────────────────────
async function fetchLive() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  try {
    const r = await fetch(`${ESPN_BASE}/scoreboard?dates=${ymd}`);
    if (!r.ok) return;
    const data = await r.json();
    (data.events || []).forEach(ev => {
      const comp  = ev.competitions?.[0] || {};
      const comps = comp.competitors || [];
      const home  = comps.find(c => c.homeAway === 'home') || comps[0] || {};
      const away  = comps.find(c => c.homeAway === 'away') || comps[1] || {};
      const key   = lk(home.team?.displayName || '', away.team?.displayName || '');
      const st    = comp.status?.type?.name || '';
      SCORES[key] = {
        status:    st,
        homeScore: home.score ?? '',
        awayScore: away.score ?? '',
        clock:     comp.status?.displayClock || '',
        isPaused:  st === 'STATUS_HALFTIME',
      };
    });
    lastUpdate = new Date();
    patchScoreBadges();
    updateTodayHeader();
    updateLiveBtnLabel();
  } catch(e) { /* silent */ }
}

// ──────────────────────────────────────────
// ESPN FETCH – STANDINGS
// ──────────────────────────────────────────
// Silent background fetch — populates STANDINGS_POS tags without touching the view
async function fetchStandingsQuiet() {
  if (STANDINGS) return;
  try {
    const r = await fetch('https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings');
    if (!r.ok) return;
    const data = await r.json();
    const groups = parseStandings(data);
    if (!groups.length) return;
    STANDINGS = groups;
    computeStandingsTags(groups);
    // Refresh visible cards with new tags, but don't disrupt standings/bracket/goldenboot views
    if (['all','tn','green','yellow','today','favorites'].includes(activeFilter)) {
      renderCurrent();
    }
  } catch(e) { /* silent */ }
}

async function fetchStandings() {
  if (STANDINGS) { renderStandings(); return; } // cached
  const el = document.getElementById('schedule');
  el.innerHTML = '<p class="msg">Loading standings…</p>';
  try {
    const r = await fetch('https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const groups = parseStandings(data);
    if (!groups.length) throw new Error('No standings data');
    STANDINGS = groups;
    computeStandingsTags(groups);
    renderStandings();
  } catch(err) {
    console.warn('Standings fetch failed:', err.message);
    el.innerHTML = `<p class="msg">Standings not available yet — they appear once group matches have been played.<br><br>Try the <strong>All</strong> or <strong>Today</strong> tabs for the schedule.</p>`;
  }
}

// Parse ESPN standings response into [{name, rows:[{team,played,win,draw,loss,gf,ga,gd,pts}]}]
function parseStandings(data) {
  // ESPN nests groups under data.children[]
  const children = data.children || data.standings?.children || [];
  const groups = [];
  children.forEach(child => {
    const groupName = child.name || child.abbreviation || 'Group';
    const entries = child.standings?.entries || [];
    if (!entries.length) return;
    const rows = entries.map(entry => {
      const team = entry.team?.displayName || entry.team?.name || 'TBD';
      const statByName = {};
      (entry.stats || []).forEach(s => { statByName[s.name || s.abbreviation] = s.value ?? s.displayValue; });
      return {
        team,
        played: statByName.gamesPlayed ?? statByName.GP ?? 0,
        win:    statByName.wins ?? statByName.W ?? 0,
        draw:   statByName.ties ?? statByName.draws ?? statByName.D ?? 0,
        loss:   statByName.losses ?? statByName.L ?? 0,
        gf:     statByName.pointsFor ?? statByName.goalsFor ?? statByName.GF ?? 0,
        ga:     statByName.pointsAgainst ?? statByName.goalsAgainst ?? statByName.GA ?? 0,
        gd:     statByName.pointDifferential ?? statByName.goalDifferential ?? statByName.GD ?? 0,
        pts:    statByName.points ?? statByName.PTS ?? 0,
      };
    });
    // Defensive sort: points desc, then GD desc, then GF desc
    rows.sort((a,b) => (b.pts - a.pts) || (b.gd - a.gd) || (b.gf - a.gf));
    groups.push({name: groupName, rows});
  });
  // Sort groups alphabetically (Group A, B, C...)
  groups.sort((a,b) => a.name.localeCompare(b.name));
  return groups;
}

// Build "2nd in Group F" tags per team, used on schedule cards
function computeStandingsTags(groups) {
  STANDINGS_POS = {};
  const ord = n => n===1?'1st':n===2?'2nd':n===3?'3rd':n+'th';
  groups.forEach(g => {
    const shortName = g.name.replace(/^Group\s*/i,'Group ');
    g.rows.forEach((r,i) => {
      STANDINGS_POS[canon(r.team)] = `${ord(i+1)} in ${shortName}`;
    });
  });
}

function renderStandings() {
  const el = document.getElementById('schedule');
  if (!STANDINGS || !STANDINGS.length) {
    el.innerHTML = '<p class="msg">Standings not available yet.</p>';
    return;
  }
  let html = '<div class="standings-grid">';
  STANDINGS.forEach(group => {
    const hasTunisia = group.rows.some(r => /tunisia/i.test(r.team));
    html += `<div class="std-card${hasTunisia ? ' tn-group' : ''}">
      <div class="std-hdr">${hasTunisia ? '🇹🇳 ' : ''}${group.name}</div>
      <table class="std-table">
        <thead><tr>
          <th></th><th class="team-col">Team</th>
          <th title="Played">P</th><th title="Won">W</th><th title="Drawn">D</th><th title="Lost">L</th>
          <th title="Goal Diff">GD</th><th title="Points">Pts</th>
        </tr></thead>
        <tbody>`;
    group.rows.forEach((r, i) => {
      const isTn = /tunisia/i.test(r.team);
      const qualLine = i === 1 ? ' qualify-line' : ''; // top 2 typically qualify
      html += `<tr class="${isTn ? 'std-row-tn' : ''}${qualLine}">
        <td class="std-rank">${i+1}</td>
        <td class="team-cell">${flagImg(r.team)}<span>${r.team}</span></td>
        <td>${r.played}</td><td>${r.win}</td><td>${r.draw}</td><td>${r.loss}</td>
        <td>${r.gd > 0 ? '+'+r.gd : r.gd}</td>
        <td class="pts">${r.pts}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

// ──────────────────────────────────────────
// BRACKET (knockout stage)
// ──────────────────────────────────────────
function renderBracket() {
  const el = document.getElementById('schedule');

  // Find knockout matches from the schedule (round contains R16/QF/SF/Final keywords)
  const koMatches = MATCHES.filter(m => m.isKO);

  if (!koMatches.length) {
    el.innerHTML = `<p class="msg">The knockout bracket isn't set yet — it fills in once group stage matches determine qualifiers.<br><br>Check the <strong>📊 Standings</strong> tab to follow group progress.</p>`;
    return;
  }

  // Group knockout matches by round label
  const order = ['Round of 32','Round of 16','Quarterfinal','Quarterfinals','Semifinal','Semifinals','Final'];
  const byRound = {};
  koMatches.forEach(m => {
    const key = order.find(o => m.round.toLowerCase().includes(o.toLowerCase().replace(/s$/,''))) || m.round;
    (byRound[key] = byRound[key] || []).push(m);
  });

  const rounds = order.filter(o => byRound[o]);
  if (!rounds.length) {
    el.innerHTML = `<p class="msg">Bracket data is still being finalized by ESPN.</p>`;
    return;
  }

  let html = '<div class="bracket-wrap"><div class="bracket">';
  rounds.forEach(roundName => {
    html += `<div class="bracket-round"><div class="bracket-round-lbl">${roundName}</div>`;
    byRound[roundName].forEach(m => {
      const sc = SCORES[m.lk];
      const hWin = sc && sc.homeScore > sc.awayScore;
      const aWin = sc && sc.awayScore > sc.homeScore;
      const hScore = sc?.homeScore ?? '';
      const aScore = sc?.awayScore ?? '';
      html += `<div class="bracket-match">
        <div class="bracket-team${hWin?' winner':''}">${flagImg(m.home)}<span>${m.home}</span><span style="margin-left:auto">${hScore}</span></div>
        <div class="bracket-vs-sep"></div>
        <div class="bracket-team${aWin?' winner':''}">${flagImg(m.away)}<span>${m.away}</span><span style="margin-left:auto">${aScore}</span></div>
      </div>`;
    });
    html += '</div>';
  });
  html += '</div></div>';
  el.innerHTML = html;
}

// ──────────────────────────────────────────
// GOLDEN BOOT (top scorers)
// ──────────────────────────────────────────
async function fetchGoldenBoot() {
  const el = document.getElementById('schedule');
  if (GOLDENBOOT) { renderGoldenBoot(); return; }
  el.innerHTML = '<p class="msg">Loading top scorers…</p>';
  try {
    const r = await fetch('https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/seasons/2026/types/3/leaders?limit=20');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const scorers = parseGoldenBoot(data);
    if (!scorers.length) throw new Error('No leader data');
    GOLDENBOOT = scorers;
    renderGoldenBoot();
  } catch(err) {
    console.warn('Golden boot fetch failed:', err.message);
    el.innerHTML = `<p class="msg">Top scorers aren't available yet — the Golden Boot race appears once group matches kick off.<br><br>Check back during the tournament.</p>`;
  }
}

function parseGoldenBoot(data) {
  // ESPN leaders response: categories[] with name "goals", leaders[]
  const categories = data.categories || data.leaders || [];
  const goalsCat = (Array.isArray(categories) ? categories : []).find(c =>
    (c.name||'').toLowerCase().includes('goal') || (c.displayName||'').toLowerCase().includes('goal')
  );
  const leaders = goalsCat?.leaders || [];
  return leaders.map(l => ({
    name: l.athlete?.displayName || l.athlete?.shortName || 'Unknown',
    team: l.team?.displayName || l.team?.abbreviation || '',
    value: l.value ?? l.displayValue ?? 0,
  })).filter(l => l.value > 0);
}

function renderGoldenBoot() {
  const el = document.getElementById('schedule');
  if (!GOLDENBOOT || !GOLDENBOOT.length) {
    el.innerHTML = '<p class="msg">No scorer data yet.</p>';
    return;
  }
  let html = '<div class="gb-list">';
  GOLDENBOOT.forEach((s, i) => {
    const rank = i+1;
    html += `<div class="gb-row">
      <div class="gb-rank${rank<=3?' top3':''}">${rank}</div>
      ${flagImg(s.team, 'gb-team-flag')}
      <div style="flex:1">
        <div class="gb-name">${s.name}</div>
        <div class="gb-team-name">${s.team}</div>
      </div>
      <div class="gb-goals">${s.value}</div>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

// ──────────────────────────────────────────
// MATCH SIDE PANEL
// ──────────────────────────────────────────
async function openMatchPanel(idx) {
  const m = MATCHES[idx];
  const overlay = document.getElementById('panelOverlay');
  const panel = document.getElementById('matchPanel');
  const body = document.getElementById('panelBody');
  const title = document.getElementById('panelTitle');

  document.getElementById('pipWidget')?.remove();
  title.textContent = m.isFinal ? 'World Cup Final' : `${m.home} vs ${m.away}`;
  overlay.classList.add('open');
  panel.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Score header (always available from MATCHES/SCORES)
  const sc = SCORES[m.lk] || {};
  const homeScore = sc.homeScore ?? '–';
  const awayScore = sc.awayScore ?? '–';
  let statusTxt = displayTime(m.utcDate) + ' · ' + displayDateLabel(m.utcDate);
  if (sc.status === 'STATUS_IN_PROGRESS') statusTxt = `LIVE · ${sc.clock || ''}`;
  else if (sc.status === 'STATUS_HALFTIME') statusTxt = 'Half time';
  else if (sc.status === 'STATUS_FINAL') statusTxt = 'Full time';

  const headerHtml = (m.home === 'TBD')
    ? `<div class="pn-score"><div class="pn-status" style="font-size:.9rem;font-weight:600">${m.round}</div></div>`
    : `<div class="pn-score">
        <div class="pn-team">${flagImg(m.home).replace('width="28" height="21"','width="40" height="30"')}<span class="pn-tname">${m.home}</span></div>
        <div class="pn-score-mid">
          <div class="pn-score-nums"><span>${homeScore}</span><span style="color:var(--text-faint);font-weight:400">–</span><span>${awayScore}</span></div>
          <div class="pn-status">${statusTxt}</div>
        </div>
        <div class="pn-team">${flagImg(m.away).replace('width="28" height="21"','width="40" height="30"')}<span class="pn-tname">${m.away}</span></div>
      </div>
      <div class="pn-section">
        <div class="pn-section-title">Match info</div>
        <div style="font-size:.78rem;color:var(--text-muted);line-height:1.6">
          ${m.round}<br>${m.venue}<br>${m.suit.icon} ${m.suit.label} (${displayTime(m.utcDate)} ${useLocalTZ?'local':'Tunisia'} time)
        </div>
      </div>`;

  body.innerHTML = headerHtml + '<div class="pn-section"><p class="msg" style="padding:20px 0">Loading match details…</p></div>';

  if (!m.id) {
    body.innerHTML = headerHtml + '<div class="pn-section"><p style="font-size:.78rem;color:var(--text-faint)">No further details available for this fixture yet.</p></div>';
    return;
  }

  // Fetch full summary
  try {
    const r = await fetch(`${ESPN_BASE}/summary?event=${m.id}`);
    if (!r.ok) throw new Error('HTTP '+r.status);
    const data = await r.json();
    body.innerHTML = headerHtml + buildPanelDetails(data, m);
    // Canvas needs to be in the DOM before we can measure it
    if (PITCH_DATA) requestAnimationFrame(() => drawPitch('home'));
  } catch(e) {
    body.innerHTML = headerHtml + `<div class="pn-section"><p style="font-size:.78rem;color:var(--text-faint)">Match details aren't available right now.</p></div>`;
  }
}

function closeMatchPanel() {
  document.getElementById('panelOverlay').classList.remove('open');
  document.getElementById('matchPanel').classList.remove('open');
  document.getElementById('matchPanel').style.transform = '';
  document.body.style.overflow = '';
  renderPip();
}

// ── Swipe-down-to-close (mobile bottom sheet) ──
(function initSwipeToClose() {
  const panel = document.getElementById('matchPanel');
  const header = document.getElementById('panelHdr') || panel.querySelector('.panel-hdr');
  let startY = 0, currentY = 0, dragging = false;

  function onStart(e) {
    if (window.innerWidth > 680) return; // only on mobile bottom-sheet
    startY = (e.touches ? e.touches[0].clientY : e.clientY);
    dragging = true;
    panel.style.transition = 'none';
  }
  function onMove(e) {
    if (!dragging) return;
    currentY = (e.touches ? e.touches[0].clientY : e.clientY);
    const delta = Math.max(0, currentY - startY);
    panel.style.transform = `translateY(${delta}px)`;
  }
  function onEnd() {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    const delta = Math.max(0, currentY - startY);
    if (delta > 100) {
      closeMatchPanel();
    } else {
      panel.style.transform = 'translateY(0)';
    }
  }

  header.addEventListener('touchstart', onStart, {passive:true});
  header.addEventListener('touchmove', onMove, {passive:true});
  header.addEventListener('touchend', onEnd);
  header.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);
})();

// ── PITCH VIEW (formation graphic) ──
// Maps ESPN position abbreviations to broad categories
// Parse "4-4-2" -> [1, 4, 4, 2] (GK + formation lines). Returns null if unparseable.
function parseFormation(formationStr, totalPlayers) {
  if (!formationStr) return null;
  const parts = formationStr.split('-').map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n > 0);
  if (!parts.length) return null;
  const sum = parts.reduce((a,b) => a+b, 0);
  // formation strings describe outfield players only; GK is implicit
  if (sum + 1 !== totalPlayers) return null; // sanity check against actual roster size
  return [1, ...parts];
}

// Slice players sequentially into rows of the given sizes (GK row first)
function sliceIntoRows(players, rowSizes) {
  const rows = [];
  let idx = 0;
  rowSizes.forEach(size => {
    rows.push(players.slice(idx, idx + size));
    idx += size;
  });
  return rows;
}

// Fallback: group by broad position category when formation string is unusable
const POS_CATEGORY = {
  GK:'GK', G:'GK',
  LB:'D', CB:'D', RB:'D', LCB:'D', RCB:'D', SW:'D', WB:'D', LWB:'D', RWB:'D', D:'D', DF:'D',
  LM:'M', CM:'M', RM:'M', LWM:'M', RWM:'M', DM:'M', CDM:'M', AM:'M', CAM:'M', LAM:'M', RAM:'M', M:'M', MF:'M',
  LW:'F', RW:'F', CF:'F', ST:'F', SS:'F', F:'F', FW:'F',
};
function categorize(p) {
  const abbr = (p.position?.abbreviation || '').toUpperCase();
  return POS_CATEGORY[abbr] || null;
}
function groupByCategory(players) {
  const groups = {GK:[], D:[], M:[], F:[]};
  players.forEach(p => {
    const cat = categorize(p);
    (cat ? groups[cat] : groups.D).push(p);
  });
  return [groups.GK, groups.D, groups.M, groups.F].filter(r => r.length);
}

// Build display rows for one team: try formation string first, fall back to position grouping
function buildFormationRows(players, formationStr) {
  const fromFormation = parseFormation(formationStr, players.length);
  if (fromFormation) return sliceIntoRows(players, fromFormation);
  return groupByCategory(players);
}

// Stash lineup data globally so the canvas can be (re)drawn on tab switch / resize
let PITCH_DATA = null;

function buildPitchView(homeStarters, awayStarters, hFormation, aFormation, m) {
  if (homeStarters.length < 7 || awayStarters.length < 7) return '';

  const hRows = buildFormationRows(homeStarters, hFormation);
  const aRows = buildFormationRows(awayStarters, aFormation);
  if (!hRows.length || !aRows.length) return '';

  PITCH_DATA = {
    home: {rows: hRows, name: m.home, formation: hFormation},
    away: {rows: aRows, name: m.away, formation: aFormation},
  };

  return `<div class="pitch-wrap">
    <div class="pitch-tabs">
      <button class="pitch-tab active" data-team="home" onclick="switchPitchTab('home')">
        ${flagImg(m.home, 'pitch-tab-flag')}<span>${m.home}</span>${hFormation ? `<span class="formation-tag">${hFormation}</span>` : ''}
      </button>
      <button class="pitch-tab" data-team="away" onclick="switchPitchTab('away')">
        ${flagImg(m.away, 'pitch-tab-flag')}<span>${m.away}</span>${aFormation ? `<span class="formation-tag">${aFormation}</span>` : ''}
      </button>
    </div>
    <canvas id="pitchCanvas" class="pitch-canvas"></canvas>
  </div>`;
}

// Draw one team's lineup on the canvas, GK at bottom, attacking upward
function drawPitch(team) {
  const canvas = document.getElementById('pitchCanvas');
  if (!canvas || !PITCH_DATA) return;
  const data = PITCH_DATA[team];
  if (!data) return;

  // Match canvas resolution to its CSS size (with devicePixelRatio for crispness)
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = Math.round(cssW * 1.35); // taller than wide
  canvas.style.height = cssH + 'px';
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const W = cssW, H = cssH;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  // ── Field background ──
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  if (isDark) {
    grad.addColorStop(0, '#1a6b3c'); grad.addColorStop(0.5, '#176338'); grad.addColorStop(1, '#1a6b3c');
  } else {
    grad.addColorStop(0, '#1f8a4c'); grad.addColorStop(0.5, '#1c7f46'); grad.addColorStop(1, '#1f8a4c');
  }
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, W, H, 8);
  ctx.fill();

  // ── Field markings ──
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 1.5;

  // Halfway line (near top, since team attacks upward off-screen)
  const halfwayY = H * 0.10;
  ctx.beginPath();
  ctx.moveTo(0, halfwayY);
  ctx.lineTo(W, halfwayY);
  ctx.stroke();

  // Center circle (centered on halfway line)
  ctx.beginPath();
  ctx.arc(W/2, halfwayY, W * 0.16, 0, Math.PI * 2);
  ctx.stroke();

  // Own goal box (bottom)
  const boxW = W * 0.5, boxH = H * 0.10;
  ctx.strokeRect((W - boxW)/2, H - boxH, boxW, boxH);
  // Six-yard box
  const sixW = W * 0.26, sixH = H * 0.045;
  ctx.strokeRect((W - sixW)/2, H - sixH, sixW, sixH);
  // Penalty arc
  ctx.beginPath();
  ctx.arc(W/2, H - boxH, W * 0.1, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();

  // ── Player rows ──
  const rows = data.rows;
  const n = rows.length;
  rows.forEach((row, rowIdx) => {
    const t = n === 1 ? 0.5 : rowIdx / (n - 1);
    // y: 0.90 (own goal, GK) up to halfwayY-ish for forwards
    const yFrac = 0.90 - t * (0.90 - (halfwayY/H + 0.05));
    const y = H * yFrac;
    row.forEach((p, i) => {
      const rowSize = row.length;
      const xFrac = rowSize === 1 ? 0.5 : 0.12 + (i / (rowSize - 1)) * 0.76;
      const x = W * xFrac;
      drawPlayer(ctx, x, y, p, team, W);
    });
  });
}

function drawPlayer(ctx, x, y, p, team, W) {
  const s = Math.max(15, W * 0.062); // jersey "size" unit
  const color = team === 'home'
    ? (getCss('--accent') || '#d42e35')
    : (getCss('--gcal') || '#1a73e8');

  drawJersey(ctx, x, y, s, color);

  // Jersey number on chest
  ctx.fillStyle = '#fff';
  ctx.font = `800 ${s*0.78}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.jersey || '', x, y + s*0.12);

  // Captain badge
  if (p.captain) {
    const cr = s * 0.36;
    const bx = x + s*0.95, by = y - s*0.85;
    ctx.beginPath();
    ctx.arc(bx, by, cr, 0, Math.PI*2);
    ctx.fillStyle = '#f0b429';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#1a1a1a';
    ctx.font = `800 ${cr*1.1}px -apple-system, sans-serif`;
    ctx.fillText('C', bx, by + 0.5);
  }

  // Name below
  const name = (p.athlete?.shortName || p.athlete?.displayName || '').split(' ').pop();
  ctx.fillStyle = isDarkMode() ? '#e8eaf0' : '#1a1a1a';
  ctx.font = `600 ${Math.max(9, W*0.028)}px -apple-system, sans-serif`;
  ctx.textBaseline = 'top';
  // Shadow for legibility on green
  ctx.shadowColor = 'rgba(0,0,0,.5)';
  ctx.shadowBlur = 2;
  ctx.fillText(truncate(name, 10), x, y + s*1.15 + 4);
  ctx.shadowBlur = 0;
}

// Draw a simple jersey silhouette centered at (x,y) with overall size unit `s`.
// Shape: sleeves on each side, collar notch at top, slightly flared hem at bottom.
function drawJersey(ctx, x, y, s, color) {
  const shoulderY  = y - s * 0.85;
  const sleeveTipY = y - s * 0.55;
  const armOutX    = s * 1.05;
  const bodyTopX   = s * 0.62;
  const bodyBotX   = s * 0.78;
  const hemY       = y + s * 0.95;
  const collarW    = s * 0.28;
  const collarDip  = s * 0.18;

  ctx.beginPath();
  // Start at left collar point
  ctx.moveTo(x - collarW, shoulderY);
  // Left shoulder out to left sleeve tip
  ctx.lineTo(x - armOutX, sleeveTipY);
  // Left sleeve underside back in to body
  ctx.lineTo(x - bodyTopX, y - s * 0.25);
  // Down left side to hem
  ctx.lineTo(x - bodyBotX, hemY);
  // Across bottom hem
  ctx.lineTo(x + bodyBotX, hemY);
  // Up right side to underarm
  ctx.lineTo(x + bodyTopX, y - s * 0.25);
  // Right sleeve underside out to tip
  ctx.lineTo(x + armOutX, sleeveTipY);
  // Right shoulder in to right collar point
  ctx.lineTo(x + collarW, shoulderY);
  // Collar notch (V neck) back to start
  ctx.quadraticCurveTo(x, shoulderY + collarDip, x - collarW, shoulderY);
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.stroke();
}

function truncate(s, n) { return s.length > n ? s.slice(0, n-1) + '…' : s; }
function isDarkMode() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
function getCss(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

function switchPitchTab(team) {
  document.querySelectorAll('.pitch-tab').forEach(b => b.classList.toggle('active', b.dataset.team === team));
  drawPitch(team);
}

// Redraw on window resize (debounced)
let pitchResizeTimer = null;
window.addEventListener('resize', () => {
  if (!PITCH_DATA) return;
  clearTimeout(pitchResizeTimer);
  pitchResizeTimer = setTimeout(() => {
    const active = document.querySelector('.pitch-tab.active');
    if (active) drawPitch(active.dataset.team);
  }, 150);
});

function buildPanelDetails(data, m) {
  let html = '';
  PITCH_DATA = null; // reset; buildPitchView will repopulate if lineups are available

  // ── Events timeline (goals, cards, subs) ──
  const keyEvents = (data.keyEvents || []).filter(e => {
    const t = (e.type?.text || '').toLowerCase();
    return t.includes('goal') || t.includes('card') || t.includes('substitution') || t.includes('penalty');
  });
  if (keyEvents.length) {
    html += `<div class="pn-section"><div class="pn-section-title">Match events</div>`;
    keyEvents.forEach(e => {
      const isHome = e.team?.id && data.boxscore?.teams?.[0]?.team?.id === e.team.id;
      const type = (e.type?.text || '').toLowerCase();
      let icon = '⚽';
      if (type.includes('yellow')) icon = '🟨';
      else if (type.includes('red')) icon = '🟥';
      else if (type.includes('substitution')) icon = '🔄';
      else if (type.includes('penalty') && type.includes('miss')) icon = '❌';
      const athlete = e.athletesInvolved?.[0]?.displayName || e.participants?.[0]?.athlete?.displayName || '';
      const assist = e.athletesInvolved?.[1]?.displayName ? `<div class="sub">Assist: ${e.athletesInvolved[1].displayName}</div>` : '';
      const min = e.clock?.displayValue || '';
      html += `<div class="pn-event${isHome ? '' : ' away-event'}">
        <span class="pn-event-min">${min}</span>
        <span class="pn-event-icon">${icon}</span>
        <span class="pn-event-text">${athlete}${assist}</span>
      </div>`;
    });
    html += `</div>`;
  }

  // ── Team stats (possession, shots, etc) ──
  const teamStats = data.boxscore?.teams;
  if (teamStats && teamStats.length === 2) {
    const home = teamStats.find(t => t.homeAway === 'home') || teamStats[0];
    const away = teamStats.find(t => t.homeAway === 'away') || teamStats[1];
    const statMap = {};
    (home.statistics || []).forEach(s => { statMap[s.name] = statMap[s.name] || {}; statMap[s.name].home = s.displayValue; });
    (away.statistics || []).forEach(s => { statMap[s.name] = statMap[s.name] || {}; statMap[s.name].away = s.displayValue; });

    const wanted = [
      ['possessionPct','Possession'],
      ['shotsTotal','Shots'],
      ['shotsOnTarget','Shots on Target'],
      ['totalCorners','Corners'],
      ['foulsCommitted','Fouls'],
      ['yellowCards','Yellow Cards'],
    ];
    const rows = wanted.filter(([key]) => statMap[key]);
    if (rows.length) {
      html += `<div class="pn-section"><div class="pn-section-title">Match stats</div>`;
      rows.forEach(([key,label]) => {
        const hv = parseFloat(statMap[key].home) || 0;
        const av = parseFloat(statMap[key].away) || 0;
        const total = hv + av || 1;
        const hp = (hv/total*100).toFixed(0);
        const ap = (av/total*100).toFixed(0);
        html += `<div class="pn-stat-row">
          <div class="pn-stat-labels"><span>${statMap[key].home ?? '–'}</span><span>${statMap[key].away ?? '–'}</span></div>
          <div class="pn-stat-bar"><div class="home-bar" style="width:${hp}%"></div><div class="away-bar" style="width:${ap}%"></div></div>
          <div class="pn-stat-name">${label}</div>
        </div>`;
      });
      html += `</div>`;
    }
  }

  // ── Lineups (pitch view) ──
  const lineups = data.rosters;
  if (lineups && lineups.length === 2) {
    const home = lineups.find(l => l.homeAway === 'home') || lineups[0];
    const away = lineups.find(l => l.homeAway === 'away') || lineups[1];

    const getFormation = roster => roster.formation || roster.team?.formation || '';
    const hFormation = getFormation(home);
    const aFormation = getFormation(away);

    const playerLabel = p => {
      const name = p.athlete?.shortName || p.athlete?.displayName || 'Unknown';
      const pos = p.position?.abbreviation || p.position?.name || '';
      const cap = p.captain ? ' <span class="cap-badge" title="Captain">C</span>' : '';
      return {name, pos, cap};
    };

    const starters = roster => (roster.roster || []).filter(p => p.starter);
    const subs     = roster => (roster.roster || []).filter(p => !p.starter);

    const hs = starters(home), as = starters(away);
    const hSubs = subs(home), aSubs = subs(away);

    if (hs.length || as.length) {
      const renderPlayer = p => {
        const {name, pos, cap} = playerLabel(p);
        return `<div class="pn-player">
          <span class="num">${p.jersey||''}</span>
          <span>${name}${cap}</span>
          ${pos ? `<span class="pos-tag">${pos}</span>` : ''}
        </div>`;
      };
      const renderSubsList = list => list.length
        ? `<details class="pn-subs">
            <summary>Substitutes (${list.length})</summary>
            ${list.map(renderPlayer).join('')}
          </details>`
        : '';

      // Try the pitch graphic; falls back to list-only if formations/positions are missing
      const pitchHtml = buildPitchView(hs, as, hFormation, aFormation, m);

      html += `<div class="pn-section">
        <div class="pn-section-title">Lineups</div>
        ${pitchHtml}
        <div class="pn-lineup-cols">
          <div class="pn-lineup-col">
            <div class="pn-lineup-team">${flagImg(m.home)}<span>${m.home}</span>${hFormation ? `<span class="formation-tag">${hFormation}</span>` : ''}</div>
            ${hs.map(renderPlayer).join('')}
            ${renderSubsList(hSubs)}
          </div>
          <div class="pn-lineup-col">
            <div class="pn-lineup-team">${flagImg(m.away)}<span>${m.away}</span>${aFormation ? `<span class="formation-tag">${aFormation}</span>` : ''}</div>
            ${as.map(renderPlayer).join('')}
            ${renderSubsList(aSubs)}
          </div>
        </div>
      </div>`;
    }
  }

  if (!html) {
    html = `<div class="pn-section"><p style="font-size:.78rem;color:var(--text-faint)">No additional details available yet for this match. Check back closer to or during kickoff.</p></div>`;
  }

  return html;
}

// ──────────────────────────────────────────
// SCORE HTML
// ──────────────────────────────────────────
function scoreHtml(key) {
  const s = SCORES[key];
  if (!s || s.status === 'STATUS_SCHEDULED' || !s.status) return '';

  const nums = `<div class="score-nums">
    <span class="sn">${s.homeScore}</span>
    <span class="s-sep">–</span>
    <span class="sn">${s.awayScore}</span>
  </div>`;

  if (s.status === 'STATUS_IN_PROGRESS') {
    return `<div class="score-area"><div class="score-live">
      ${nums}
      <span class="live-pill"><span class="pulse"></span>${s.clock || 'LIVE'}</span>
    </div></div>`;
  }
  if (s.status === 'STATUS_HALFTIME') {
    return `<div class="score-area"><div class="score-live">
      ${nums}
      <span class="ht-pill">HT</span>
    </div></div>`;
  }
  if (s.status === 'STATUS_FINAL' || s.status === 'STATUS_FULL_TIME') {
    return `<div class="score-area"><div class="score-final">
      ${nums}
      <span class="ft-pill">FT</span>
    </div></div>`;
  }
  // Fallback for any other "in-play" status
  if (s.homeScore !== '' && s.awayScore !== '') {
    return `<div class="score-area"><div class="score-live">
      ${nums}
      <span class="live-pill"><span class="pulse"></span>${s.clock || 'LIVE'}</span>
    </div></div>`;
  }
  return '';
}

// Patch scores into existing DOM without full re-render
function patchScoreBadges() {
  document.querySelectorAll('.mc[data-lk]').forEach(card => {
    const key = card.dataset.lk;
    const sa  = card.querySelector('.score-area-wrap');
    if (sa) sa.innerHTML = scoreHtml(key);
    const s = SCORES[key];
    const isLive = s && s.status === 'STATUS_IN_PROGRESS';
    const isHT   = s && s.status === 'STATUS_HALFTIME';
    card.classList.toggle('live-card', isLive || isHT);
  });
  renderPip();
}

// ──────────────────────────────────────────
// PIP (floating live score widget)
// ──────────────────────────────────────────

// All currently live (in-progress or half-time) matches, in schedule order
function liveMatches() {
  return MATCHES
    .map((m,i) => ({m,i}))
    .filter(({m}) => {
      const s = SCORES[m.lk];
      return s && (s.status === 'STATUS_IN_PROGRESS' || s.status === 'STATUS_HALFTIME');
    });
}

// Pin/unpin a match to the PiP widget
function togglePip(lk) {
  if (PIP_LK === lk) {
    PIP_LK = null; // unpin if clicking the same match's pin again
  } else {
    PIP_LK = lk;
    PIP_DISMISSED = false;
  }
  renderCurrent(); // update pin button active state on cards
  renderPip();
}

// Cycle to the next/previous live match in the PiP (for the multi-match edge case)
function cyclePip(direction) {
  const live = liveMatches();
  if (!live.length) return;
  const idx = live.findIndex(({m}) => m.lk === PIP_LK);
  let next;
  if (idx === -1) next = 0;
  else next = (idx + direction + live.length) % live.length;
  PIP_LK = live[next].m.lk;
  renderPip();
}

function closePip() {
  PIP_LK = null;
  PIP_DISMISSED = true;
  renderCurrent();
  renderPip();
}

function pipOpenPanel() {
  const live = liveMatches();
  const entry = live.find(({m}) => m.lk === PIP_LK);
  if (entry) openMatchPanel(entry.i);
}

function renderPip() {
  // Don't show/create the PiP while the match detail panel is open
  if (document.getElementById('matchPanel')?.classList.contains('open')) return;

  let el = document.getElementById('pipWidget');
  const live = liveMatches();

  // Auto-pick: if nothing pinned yet, not dismissed, and exactly one live match, show it automatically.
  // With multiple concurrent matches, wait for the user to pin one (avoids guessing which they care about).
  if (!PIP_LK && !PIP_DISMISSED && live.length === 1) {
    PIP_LK = live[0].m.lk;
  }

  // If the pinned match is no longer live (finished), drop it —
  // but if other matches are still live, offer to switch via the cycle arrows instead of closing outright
  if (PIP_LK && !live.some(({m}) => m.lk === PIP_LK)) {
    if (live.length) {
      PIP_LK = live[0].m.lk; // hand off to another live match
    } else {
      PIP_LK = null; // nothing left live — close
    }
  }

  if (!PIP_LK || !live.length) {
    if (el) el.remove();
    return;
  }

  const entry = live.find(({m}) => m.lk === PIP_LK);
  const m = entry.m;
  const sc = SCORES[m.lk] || {};
  const idxInLive = live.findIndex(({m: mm}) => mm.lk === PIP_LK);

  const statusBadge = sc.status === 'STATUS_HALFTIME'
    ? `<span class="pip-status ht">HT</span>`
    : `<span class="pip-status live"><span class="live-dot"></span>${sc.clock || 'LIVE'}</span>`;

  const counter = live.length > 1
    ? `<span class="pip-counter">${idxInLive+1}/${live.length}</span>`
    : '';

  const html = `
    <div class="pip-top">
      ${live.length > 1 ? `<button class="pip-nav" onclick="cyclePip(-1)" title="Previous live match">‹</button>` : ''}
      <div class="pip-teams" onclick="pipOpenPanel()">
        <div class="pip-team">${flagImg(m.home, 'pip-flag')}<span class="pip-score">${sc.homeScore ?? ''}</span></div>
        <div class="pip-mid">${statusBadge}${counter}</div>
        <div class="pip-team">${flagImg(m.away, 'pip-flag')}<span class="pip-score">${sc.awayScore ?? ''}</span></div>
      </div>
      ${live.length > 1 ? `<button class="pip-nav" onclick="cyclePip(1)" title="Next live match">›</button>` : ''}
      <button class="pip-close" onclick="closePip()" title="Close">✕</button>
    </div>
    <div class="pip-names" onclick="pipOpenPanel()">
      <span>${truncate(m.home, 12)}</span><span>vs</span><span>${truncate(m.away, 12)}</span>
    </div>`;

  if (!el) {
    el = document.createElement('div');
    el.id = 'pipWidget';
    el.className = 'pip-widget';
    document.body.appendChild(el);
  }
  el.innerHTML = html;
}

// ──────────────────────────────────────────
// CARD BUILDER
// ──────────────────────────────────────────
function buildCard(m, idx) {
  const tn  = isTN(m) ? ' tn-card' : '';
  const fin = m.isFinal ? ' fin-card' : '';
  const bCls = m.isFinal ? ' b-fin' : m.isKO ? ' b-ko' : '';
  const sc  = SCORES[m.lk];
  const isLive = sc && (sc.status === 'STATUS_IN_PROGRESS' || sc.status === 'STATUS_HALFTIME');
  const live = isLive ? ' live-card' : '';

  const homeTag = STANDINGS_POS[canon(m.home)] ? `<span class="std-tag">${STANDINGS_POS[canon(m.home)]}</span>` : '';
  const awayTag = STANDINGS_POS[canon(m.away)] ? `<span class="std-tag">${STANDINGS_POS[canon(m.away)]}</span>` : '';

  const teamsHtml = (m.home === 'TBD' || !m.home)
    ? `<div class="tbd-block"><span class="tbd-txt">${m.isFinal ? '🏆 World Cup Final' : m.round}</span></div>`
    : `<div class="mc-teams">
        <div class="mc-team">${flagImg(m.home)}<div class="tname-row"><span class="tname">${m.home}</span>${homeTag}</div></div>
        <div class="mc-vs">vs</div>
        <div class="mc-team">${flagImg(m.away)}<div class="tname-row"><span class="tname">${m.away}</span>${awayTag}</div></div>
      </div>`;

  const favBtn = (m.home !== 'TBD' && m.home)
    ? `<div class="fav-star${isFavoriteMatch(m)?' active':''}" onclick="event.stopPropagation();toggleFavoriteMatch(${idx})" title="Star this match">★</div>`
    : '';

  const pipBtn = isLive
    ? `<button class="pip-pin${PIP_LK===m.lk?' active':''}" onclick="event.stopPropagation();togglePip('${m.lk}')" title="Pin live score">📌</button>`
    : '';

  return `<div class="mc${tn}${fin}${live}" data-lk="${m.lk}" data-id="${m.id||''}" onclick="if(!event.target.closest('.mc-cal')&&!event.target.closest('.fav-star')&&!event.target.closest('.pip-pin')) openMatchPanel(${idx})" style="cursor:pointer">
    <div class="mc-top">
      <div class="mc-top-left">
        ${favBtn}
        <span class="mc-badge${bCls}">${m.round}</span>
      </div>
      <div class="mc-time-wrap">
        ${pipBtn}
        <span class="mc-time">${displayTime(m.utcDate)}</span>
        <span class="mc-cdot c${m.suit.cls[0]}"></span>
      </div>
    </div>
    ${teamsHtml}
    <div class="score-area-wrap">${scoreHtml(m.lk)}</div>
    <div class="mc-meta">
      <span class="mc-venue">${m.venue}</span>
      <span class="mc-suit sc-${m.suit.cls}">${m.suit.icon} ${m.suit.label}</span>
    </div>
    <div class="mc-cal">
      <a class="cbtn c-gcal" href="${gcalUrl(m)}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5C3.9 4 3 4.9 3 6v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z"/></svg>
        Google Cal
      </a>
      <button class="cbtn c-ics" onclick="event.stopPropagation();dlIcs(${idx})">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg>
        .ics
      </button>
    </div>
  </div>`;
}

// ──────────────────────────────────────────
// RENDER
// ──────────────────────────────────────────
function renderCurrent() { render(activeFilter); }

function render(filter) {
  activeFilter = filter;
  const el = document.getElementById('schedule');

  if (filter === 'standings')  { fetchStandings(); return; }
  if (filter === 'bracket')    { renderBracket(); return; }
  if (filter === 'goldenboot') { fetchGoldenBoot(); return; }

  let items = MATCHES.map((m,i) => ({m,i}));

  // Apply search across all filters
  items = items.filter(({m}) => matchesSearch(m));

  if (filter === 'today') {
    const today = todayTun();
    items = items.filter(({m}) => m.dateStr === today);

    if (!items.length) {
      el.innerHTML = '<p class="msg">No matches today.</p>';
      return;
    }

    const liveCount = items.filter(({m}) => {
      const s = SCORES[m.lk];
      return s && (s.status === 'STATUS_IN_PROGRESS' || s.status === 'STATUS_HALFTIME');
    }).length;

    let html = `<div class="day-block">
      <div class="today-hdr">
        <span class="today-lbl">Today · ${todayDisplay()}</span>
        ${liveCount ? `<span class="live-cnt" id="live-cnt">${liveCount} LIVE</span>` : '<span id="live-cnt"></span>'}
        <button class="rfr-btn" onclick="fetchLive()">↻ Refresh</button>
        <span class="upd-lbl" id="upd-lbl">${lastUpdate ? 'Updated ' + lastUpdate.toLocaleTimeString() : ''}</span>
      </div>
      <div class="day-grid">`;
    items.forEach(({m,i}) => { html += buildCard(m,i); });
    html += '</div></div>';
    el.innerHTML = html;
    return;
  }

  if (filter === 'tn')        items = items.filter(({m}) => isTN(m));
  if (filter === 'green')     items = items.filter(({m}) => m.suit.cls === 'green');
  if (filter === 'yellow')    items = items.filter(({m}) => m.suit.cls === 'yellow');
  if (filter === 'favorites') items = items.filter(({m}) => isFavoriteMatch(m));

  if (!items.length) {
    if (filter === 'favorites' && !favorites.size) {
      el.innerHTML = '<p class="msg">No favorites yet — tap the ★ on any match card to follow a team.</p>';
    } else {
      el.innerHTML = '<p class="msg">No matches for this filter.</p>';
    }
    return;
  }

  const byDate = {};
  items.forEach(({m,i}) => {
    (byDate[m.dateStr] = byDate[m.dateStr] || []).push({m,i});
  });

  let html = '';
  for (const [date, list] of Object.entries(byDate)) {
    const label = useLocalTZ ? displayDateLabel(list[0].m.utcDate) : date;
    html += `<div class="day-block"><div class="day-lbl">${label}</div><div class="day-grid">`;
    list.forEach(({m,i}) => { html += buildCard(m,i); });
    html += '</div></div>';
  }
  el.innerHTML = html;
}

// ──────────────────────────────────────────
// TODAY HEADER UPDATE (no full re-render)
// ──────────────────────────────────────────
function updateTodayHeader() {
  if (activeFilter !== 'today') return;
  const upd = document.getElementById('upd-lbl');
  if (upd && lastUpdate) upd.textContent = 'Updated ' + lastUpdate.toLocaleTimeString();
  updateLiveCntBadge();
}

function updateLiveCntBadge() {
  const el = document.getElementById('live-cnt');
  if (!el) return;
  const today = todayTun();
  const count = MATCHES.filter(m => m.dateStr === today).filter(m => {
    const s = SCORES[m.lk]; return s && (s.status==='STATUS_IN_PROGRESS'||s.status==='STATUS_HALFTIME');
  }).length;
  el.textContent = count ? count + ' LIVE' : '';
  el.style.display = count ? '' : 'none';
}

function updateLiveBtnLabel() {
  const today = todayTun();
  const liveCount = MATCHES.filter(m => m.dateStr === today).filter(m => {
    const s = SCORES[m.lk]; return s && (s.status==='STATUS_IN_PROGRESS'||s.status==='STATUS_HALFTIME');
  }).length;
  document.getElementById('btn-today').textContent = liveCount ? `📅 Today · ${liveCount} LIVE` : '📅 Today';
}

// ──────────────────────────────────────────
// STATS
// ──────────────────────────────────────────
function updateStats() {
  let g=0,y=0,r=0,tn=0;
  MATCHES.forEach(m => {
    if (m.suit.cls==='green') g++; else if (m.suit.cls==='yellow') y++; else r++;
    if (isTN(m)) tn++;
  });
  document.getElementById('cnt-g').textContent = g;
  document.getElementById('cnt-y').textContent = y;
  document.getElementById('cnt-r').textContent = r;
  document.getElementById('cnt-tn').textContent = tn;
  document.getElementById('cnt-tot').textContent = MATCHES.length;
}

// ──────────────────────────────────────────
// STATIC FALLBACK
// ──────────────────────────────────────────
function useStaticFallback() {
  const D = [
    ["Mexico","South Africa","2026-06-11T23:00:00Z","Estadio Azteca","Group A"],
    ["South Korea","Czechia","2026-06-12T06:00:00Z","Estadio Guadalajara","Group A"],
    ["Canada","Bosnia and Herzegovina","2026-06-12T23:00:00Z","BMO Field","Group B"],
    ["United States","Paraguay","2026-06-13T05:00:00Z","SoFi Stadium","Group D"],
    ["Qatar","Switzerland","2026-06-13T23:00:00Z","Levi's Stadium","Group B"],
    ["Brazil","Morocco","2026-06-14T02:00:00Z","MetLife Stadium","Group C"],
    ["Haiti","Scotland","2026-06-14T05:00:00Z","Gillette Stadium","Group C"],
    ["Australia","Türkiye","2026-06-14T08:00:00Z","BC Place","Group D"],
    ["Germany","Curaçao","2026-06-14T21:00:00Z","NRG Stadium","Group E"],
    ["Netherlands","Japan","2026-06-15T00:00:00Z","AT&T Stadium","Group F"],
    ["Ivory Coast","Ecuador","2026-06-15T03:00:00Z","Lincoln Financial Field","Group E"],
    ["Sweden","Tunisia","2026-06-15T06:00:00Z","Estadio Monterrey","Group F"],
    ["Spain","Cabo Verde","2026-06-15T20:00:00Z","Mercedes-Benz Stadium","Group H"],
    ["Belgium","Egypt","2026-06-15T23:00:00Z","Lumen Field","Group G"],
    ["Saudi Arabia","Uruguay","2026-06-16T02:00:00Z","Hard Rock Stadium","Group H"],
    ["Iran","New Zealand","2026-06-16T05:00:00Z","SoFi Stadium","Group G"],
    ["France","Senegal","2026-06-16T23:00:00Z","MetLife Stadium","Group I"],
    ["Iraq","Norway","2026-06-17T02:00:00Z","Gillette Stadium","Group I"],
    ["Argentina","Algeria","2026-06-17T05:00:00Z","Arrowhead Stadium","Group J"],
    ["Austria","Jordan","2026-06-17T08:00:00Z","Levi's Stadium","Group J"],
    ["Ghana","Panama","2026-06-17T23:00:00Z","BMO Field","Group L"],
    ["England","Croatia","2026-06-18T02:00:00Z","AT&T Stadium","Group L"],
    ["Portugal","Congo DR","2026-06-18T05:00:00Z","NRG Stadium","Group K"],
    ["Uzbekistan","Colombia","2026-06-18T08:00:00Z","Estadio Azteca","Group K"],
    ["Czechia","South Africa","2026-06-18T21:00:00Z","Mercedes-Benz Stadium","Group A"],
    ["Switzerland","Bosnia and Herzegovina","2026-06-19T00:00:00Z","SoFi Stadium","Group B"],
    ["Canada","Qatar","2026-06-19T03:00:00Z","BC Place","Group B"],
    ["Mexico","South Korea","2026-06-19T06:00:00Z","Estadio Guadalajara","Group A"],
    ["USA","Australia","2026-06-19T23:00:00Z","Lumen Field","Group D"],
    ["Scotland","Morocco","2026-06-20T02:00:00Z","Gillette Stadium","Group C"],
    ["Türkiye","Paraguay","2026-06-20T05:00:00Z","Levi's Stadium","Group D"],
    ["Brazil","Haiti","2026-06-20T08:00:00Z","Lincoln Financial Field","Group C"],
    ["Germany","Ivory Coast","2026-06-21T00:00:00Z","BMO Field","Group E"],
    ["Ecuador","Curaçao","2026-06-21T03:00:00Z","Arrowhead Stadium","Group E"],
    ["Tunisia","Japan","2026-06-21T07:00:00Z","Estadio Monterrey","Group F"],
    ["Spain","Saudi Arabia","2026-06-22T00:00:00Z","Mercedes-Benz Stadium","Group H"],
    ["Belgium","Iran","2026-06-22T03:00:00Z","SoFi Stadium","Group G"],
    ["Uruguay","Cabo Verde","2026-06-22T06:00:00Z","Hard Rock Stadium","Group H"],
    ["New Zealand","Egypt","2026-06-22T08:00:00Z","BC Place","Group G"],
    ["Argentina","Austria","2026-06-23T02:00:00Z","AT&T Stadium","Group J"],
    ["France","Iraq","2026-06-23T05:00:00Z","Lincoln Financial Field","Group I"],
    ["Norway","Senegal","2026-06-23T08:00:00Z","MetLife Stadium","Group I"],
    ["Jordan","Algeria","2026-06-23T23:00:00Z","Levi's Stadium","Group J"],
    ["Portugal","Uzbekistan","2026-06-24T02:00:00Z","NRG Stadium","Group K"],
    ["England","Ghana","2026-06-24T05:00:00Z","Gillette Stadium","Group L"],
    ["Panama","Croatia","2026-06-24T08:00:00Z","BMO Field","Group L"],
    ["Colombia","Congo DR","2026-06-24T08:00:00Z","Estadio Guadalajara","Group K"],
    ["Switzerland","Canada","2026-06-24T23:00:00Z","BC Place","Group B"],
    ["Bosnia and Herzegovina","Qatar","2026-06-24T23:00:00Z","Lumen Field","Group B"],
    ["Morocco","Haiti","2026-06-25T02:00:00Z","Mercedes-Benz Stadium","Group C"],
    ["Scotland","Brazil","2026-06-25T02:00:00Z","Hard Rock Stadium","Group C"],
    ["South Africa","South Korea","2026-06-25T06:00:00Z","Estadio Monterrey","Group A"],
    ["Czechia","Mexico","2026-06-25T06:00:00Z","Estadio Azteca","Group A"],
    ["Curaçao","Ivory Coast","2026-06-26T00:00:00Z","Lincoln Financial Field","Group E"],
    ["Ecuador","Germany","2026-06-26T00:00:00Z","MetLife Stadium","Group E"],
    ["Tunisia","Netherlands","2026-06-26T07:30:00Z","Arrowhead Stadium","Group F"],
    ["Japan","Sweden","2026-06-26T07:30:00Z","AT&T Stadium","Group F"],
    ["Türkiye","USA","2026-06-26T10:30:00Z","SoFi Stadium","Group D"],
    ["Paraguay","Australia","2026-06-26T10:30:00Z","Levi's Stadium","Group D"],
    ["Norway","France","2026-06-26T23:00:00Z","Gillette Stadium","Group I"],
    ["Senegal","Iraq","2026-06-26T23:00:00Z","BMO Field","Group I"],
    ["Cabo Verde","Saudi Arabia","2026-06-27T04:30:00Z","NRG Stadium","Group H"],
    ["Uruguay","Spain","2026-06-27T04:30:00Z","Estadio Guadalajara","Group H"],
    ["New Zealand","Belgium","2026-06-27T07:30:00Z","SoFi Stadium","Group G"],
    ["Egypt","Iran","2026-06-27T07:30:00Z","Lumen Field","Group G"],
    ["Panama","England","2026-06-27T23:00:00Z","MetLife Stadium","Group L"],
    ["Croatia","Ghana","2026-06-27T23:00:00Z","Lincoln Financial Field","Group L"],
    ["Colombia","Portugal","2026-06-28T02:30:00Z","Hard Rock Stadium","Group K"],
    ["Congo DR","Uzbekistan","2026-06-28T02:30:00Z","Mercedes-Benz Stadium","Group K"],
    ["Algeria","Austria","2026-06-28T06:00:00Z","Arrowhead Stadium","Group J"],
    ["Jordan","Argentina","2026-06-28T06:00:00Z","AT&T Stadium","Group J"],
    ["TBD","TBD","2026-07-19T23:00:00Z","MetLife Stadium","Final"],
  ];
  MATCHES = D.map(([h,a,utc,venue,round]) => {
    const s = suit(utc);
    const isF = round === 'Final';
    return {home:h,away:a,utcDate:utc,timeStr:tunTime(utc),dateStr:tunDate(utc),venue,round,suit:s,lk:lk(h,a),isFinal:isF,isKO:isF,homeScore:null,awayScore:null,status:'STATUS_SCHEDULED',clock:''};
  }).sort((a,b) => new Date(a.utcDate)-new Date(b.utcDate));
  updateStats();
  renderCurrent();
  renderPip();
}

// ──────────────────────────────────────────
// FILTERS
// ──────────────────────────────────────────
document.querySelectorAll('.fb').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.fb').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    render(b.dataset.f);
    if (b.dataset.f === 'today') fetchLive();
    if (b.dataset.f === 'standings') { STANDINGS = null; fetchStandings(); }
  });
});

// ──────────────────────────────────────────
// THEME
// ──────────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.getElementById('themeBtn').textContent = dark ? '☀️ Light' : '🌙 Dark';
  if (PITCH_DATA) {
    const active = document.querySelector('.pitch-tab.active');
    if (active) drawPitch(active.dataset.team);
  }
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') !== 'dark');
}
applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);

// Close panel on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeMatchPanel();
});

// ──────────────────────────────────────────
// INIT
// ──────────────────────────────────────────
loadFavorites();
fetchSchedule();
// Pre-fetch standings tags in background (silent, doesn't change view)
fetchStandingsQuiet();
// Auto-refresh live scores every 60s
refreshTimer = setInterval(async () => {
  await fetchLive();
  // Also re-fetch full schedule once per 5 min to catch any fixture changes
}, 60000);

// ── PWA: register service worker for offline shell caching ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* silent */ });
  });
}
