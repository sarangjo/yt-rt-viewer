'use strict';

/* =====================================================================
   RT Archive Viewer
   - data/videos.json: every upload, sorted oldest-first (built by scripts/build_data.py)
   - progress lives in localStorage (key rtv.v1) and is mirrored to data/progress.json
     through server.py, newest copy wins on load.
   ===================================================================== */

const STORE_KEY = 'rtv.v1';
const ROW_H = 76;
const SAVE_EVERY_MS = 2000;        // localStorage write cadence while playing
const SERVER_SYNC_MS = 15000;      // data/progress.json write cadence
const WATCHED_FRACTION = 0.92;     // leaving a video after this point counts as watched
const SKIP_COUNTDOWN_S = 5;

const CHANNEL_NAMES = { RT: 'Rooster Teeth', AH: 'Achievement Hunter', LP: "Let's Play" };
const TYPE_NAMES = { video: 'Videos', short: 'Shorts', stream: 'Streams' };
const UNAVAILABLE = 'YouTube won\'t play this one in an embedded player: it was removed or made private, is members-only or age-restricted, or the owner disabled embedding.';
const ERROR_TEXT = {
  2: 'The video ID looks invalid.',
  5: 'The browser player hit an error playing this video.',
  100: UNAVAILABLE,
  101: UNAVAILABLE,
  150: UNAVAILABLE,
  152: UNAVAILABLE,
  153: 'YouTube rejected the embed request. Open the site through server.py (http://localhost:8642), not as a file.',
};

// Title filters from filters.js (chips like "Red vs. Blue"). Bad entries are skipped, not fatal.
// (drops the g/y flags, which would make .test() stateful)
const toRegex = (x) => (x instanceof RegExp ? new RegExp(x.source, x.flags.replace(/[gy]/g, ''))
  : typeof x === 'string' && x ? new RegExp(x, 'i') : null);
const TITLE_FILTERS = (Array.isArray(window.TITLE_FILTERS) ? window.TITLE_FILTERS : []).flatMap((f) => {
  try {
    const match = toRegex(f.match);
    if (!f.id || !match) throw new Error('needs an id and a match pattern');
    return [{ id: String(f.id), label: f.label || String(f.id), match, exclude: toRegex(f.exclude),
      channels: Array.isArray(f.channels) && f.channels.length ? f.channels : null, skip: f.skip === true }];
  } catch (e) { console.warn('filters.js: ignoring filter', f, e.message); return []; }
});

/* ---------------- state ---------------- */
let ALL = [];            // [{id,title,ts,dur,ch,type,flags,i}]
let byId = new Map();    // id -> index in ALL
let navList = [];        // indices into ALL that pass the channel/type filters (navigation order)
let listItems = [];      // indices shown in the sidebar (navList, optionally narrowed by search)
let cur = 0;             // index into ALL of the current video
let player = null;
let playerReady = false;
let lastDir = 1;         // +1 next, -1 prev: direction to continue when auto-skipping
let skipTimer = null;
let dirty = false;       // unsynced changes for the server
let lastLocalSave = 0;
let resumeNote = null;    // {id, t} shown until playback starts after a reload
let importing = false;
// Only write to the server after reading its copy, so a tab that couldn't see the saved
// progress never overwrites it with an empty one.
let serverSeen = false;

let store = {
  at: 0,
  current: null,         // {id, t}
  progress: {},          // id -> seconds watched, or -1 when finished
  bad: {},               // id -> YouTube error code
  settings: {
    channels: { RT: true, AH: true, LP: true },
    types: { video: true, short: true, stream: true },
    titles: {},          // title filter id -> false when its videos are skipped
    autoNext: true,
    autoSkip: true,
    hideEndscreens: true, // privacy-mode player: no end-screen cards
  },
};

const $ = (id) => document.getElementById(id);

/* ---------------- persistence ---------------- */
function loadLocal() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}

async function loadServer() {
  try {
    const r = await fetch('api/progress', { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || typeof d !== 'object') return null;
    serverSeen = true;
    return d.at ? d : null;
  } catch { return null; }
}

function mergeStore(saved) {
  if (!saved) return;
  store.at = saved.at || 0;
  store.current = saved.current || null;
  store.progress = saved.progress || {};
  store.bad = saved.bad || {};
  const s = saved.settings || {};
  Object.assign(store.settings.channels, s.channels || {});
  Object.assign(store.settings.types, s.types || {});
  Object.assign(store.settings.titles, s.titles || {});
  if (typeof s.autoNext === 'boolean') store.settings.autoNext = s.autoNext;
  if (typeof s.autoSkip === 'boolean') store.settings.autoSkip = s.autoSkip;
  if (typeof s.hideEndscreens === 'boolean') store.settings.hideEndscreens = s.hideEndscreens;
}

function saveLocal() {
  store.at = Date.now();
  lastLocalSave = store.at;
  dirty = true;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { console.warn('localStorage save failed', e); }
}

function syncServer(useBeacon = false) {
  if (!dirty) return;
  if (!serverSeen) { loadServer().then((d) => adoptExternal(d)); return; } // try again next round
  dirty = false;
  const body = JSON.stringify(store);
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon('api/progress', new Blob([body], { type: 'application/json' }));
    return;
  }
  fetch('api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .then((r) => { if (!r.ok && r.status !== 409) dirty = true; })
    .catch(() => { dirty = true; });
}

/* ---------------- helpers ---------------- */
const fmtDate = (ts) => ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'date unknown';
const fmtDateTime = (ts) => ts ? new Date(ts * 1000).toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'date not looked up yet';
const fmtMonth = (ts) => ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long' }) : 'Date unknown';
const fmtNum = (n) => n.toLocaleString();
function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// first position in sorted array `arr` (of ALL indices) whose value is >= target index
function lowerBound(arr, target, key = (x) => x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (key(arr[mid]) < target) lo = mid + 1; else hi = mid; }
  return lo;
}

const isWatched = (v) => store.progress[v.id] === -1;
const titleOn = (f) => (f.id in store.settings.titles ? store.settings.titles[f.id] !== false : !f.skip);
const passes = (v) => store.settings.channels[v.ch] !== false && store.settings.types[v.type] !== false &&
  !(v.tags && v.tags.some((f) => !titleOn(f)));

/* ---------------- filters / lists ---------------- */
function rebuildNav() {
  navList = [];
  for (let i = 0; i < ALL.length; i++) if (passes(ALL[i])) navList.push(i);
  rebuildList();
  renderStats();
  renderNow();
}

function rebuildList() {
  const q = $('search').value.trim().toLowerCase();
  if (!q) {
    listItems = navList;
  } else {
    const terms = q.split(/\s+/);
    listItems = navList.filter((i) => { const t = ALL[i].lc; return terms.every((w) => t.includes(w)); });
  }
  $('listCount').textContent = q
    ? `${fmtNum(listItems.length)} match${listItems.length === 1 ? '' : 'es'}`
    : `${fmtNum(listItems.length)} videos`;
  $('listSpacer').style.height = `${listItems.length * ROW_H}px`;
  rowCache.forEach((el) => el.remove());
  rowCache.clear();
  renderRows();
}

function renderFilters() {
  const counts = { RT: 0, AH: 0, LP: 0, video: 0, short: 0, stream: 0 };
  for (const v of ALL) { counts[v.ch]++; counts[v.type]++; }
  const box = $('filters');
  box.innerHTML = '';
  const chip = (label, n, on, color, onClick) => {
    const b = document.createElement('button');
    b.className = 'chip' + (on ? '' : ' off');
    b.innerHTML = `${color ? `<span class="dot" style="background:var(--${color})"></span>` : ''}${esc(label)} <span class="n">${fmtNum(n)}</span>`;
    b.onclick = onClick;
    box.appendChild(b);
  };
  for (const ch of ['RT', 'AH', 'LP']) {
    if (!counts[ch]) continue;
    chip(CHANNEL_NAMES[ch], counts[ch], store.settings.channels[ch] !== false, ch, () => {
      store.settings.channels[ch] = store.settings.channels[ch] === false;
      afterFilterChange();
    });
  }
  const sep = document.createElement('span'); sep.className = 'sep'; box.appendChild(sep);
  for (const t of ['video', 'short', 'stream']) {
    if (!counts[t]) continue;
    chip(TYPE_NAMES[t], counts[t], store.settings.types[t] !== false, null, () => {
      store.settings.types[t] = store.settings.types[t] === false;
      afterFilterChange();
    });
  }
  if (TITLE_FILTERS.length) {
    const sep2 = document.createElement('span'); sep2.className = 'sep'; box.appendChild(sep2);
  }
  for (const f of TITLE_FILTERS) {
    const n = ALL.reduce((k, v) => k + (v.tags ? v.tags.includes(f) : 0), 0);
    chip(f.label, n, titleOn(f), null, () => {
      store.settings.titles[f.id] = !titleOn(f);
      afterFilterChange();
    });
    box.lastChild.title = titleOn(f) ? `Click to skip ${f.label} videos` : `Skipping ${f.label} videos — click to include them again`;
  }
}

function afterFilterChange() {
  saveLocal();
  renderFilters();
  rebuildNav();
  scrollToIndex(cur, 'center');
}

function renderStats() {
  let watched = 0;
  for (const i of navList) if (isWatched(ALL[i])) watched++;
  const pct = navList.length ? (watched / navList.length) * 100 : 0;
  $('stats').innerHTML = `<span><b>${fmtNum(watched)}</b> of ${fmtNum(navList.length)} watched (${pct.toFixed(pct < 10 ? 2 : 1)}%)</span>` +
    `<span class="bar"><i style="width:${pct}%"></i></span>`;
}

/* ---------------- virtualized sidebar ---------------- */
const rowCache = new Map(); // listItems position -> element
let renderQueued = false;

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderRows(); });
}

function rowHtml(v) {
  const p = store.progress[v.id];
  const watched = p === -1;
  const frac = watched ? 1 : (p > 0 && v.dur ? Math.min(1, p / v.dur) : 0);
  const typeTag = v.type === 'short' ? '<span class="tag">Short</span>' : v.type === 'stream' ? '<span class="tag">Stream</span>' : '';
  return `<div class="thumb"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg">` +
    (v.dur ? `<span class="dur">${fmtDur(v.dur)}</span>` : '') +
    (watched ? '<span class="check">&#10003; watched</span>' : '') +
    (frac > 0 ? `<span class="prog" style="width:${frac * 100}%"></span>` : '') +
    `</div><div class="body"><div class="title">${esc(v.title)}</div>` +
    `<div class="meta"><span class="badge ${v.ch}">${v.ch}</span>${typeTag}<span${v.approx ? ' title="Estimated date"' : ''}>${v.approx && v.ts ? '≈ ' : ''}${fmtDate(v.ts)}</span>` +
    `<span class="num">#${fmtNum(v.i + 1)}</span></div></div>`;
}

function rowClass(v) {
  return 'row' + (v.i === cur ? ' cur' : '') + (isWatched(v) ? ' watched' : '') + (store.bad[v.id] ? ' bad' : '');
}

function renderRows() {
  const list = $('list');
  const top = list.scrollTop, h = list.clientHeight || 600;
  const first = Math.max(0, Math.floor(top / ROW_H) - 6);
  const last = Math.min(listItems.length - 1, Math.ceil((top + h) / ROW_H) + 6);

  for (const [pos, el] of rowCache) {
    if (pos < first || pos > last) { el.remove(); rowCache.delete(pos); }
  }
  for (let pos = first; pos <= last; pos++) {
    const v = ALL[listItems[pos]];
    let el = rowCache.get(pos);
    if (!el) {
      el = document.createElement('div');
      el.style.top = `${pos * ROW_H}px`;
      el.dataset.idx = v.i;
      el.innerHTML = rowHtml(v);
      list.appendChild(el);
      rowCache.set(pos, el);
    }
    el.className = rowClass(v);
  }
  const topItem = listItems[Math.min(listItems.length - 1, Math.floor(top / ROW_H))];
  $('listDate').textContent = topItem !== undefined ? fmtMonth(ALL[topItem].ts) : '';
  if (!listItems.length && !list.querySelector('.empty')) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No videos match.'; list.appendChild(e);
  } else if (listItems.length) {
    list.querySelector('.empty')?.remove();
  }
}

function refreshRow(idx) {
  for (const [, el] of rowCache) {
    if (+el.dataset.idx === idx) { const v = ALL[idx]; el.innerHTML = rowHtml(v); el.className = rowClass(v); }
  }
}

function scrollToIndex(idx, align = 'nearest', tries = 0) {
  const pos = lowerBound(listItems, idx);
  if (pos >= listItems.length) return;
  const list = $('list');
  if (!list.clientHeight) { // not laid out yet: try again next frame
    if (tries < 60) requestAnimationFrame(() => scrollToIndex(idx, align, tries + 1));
    return;
  }
  const y = pos * ROW_H;
  if (align === 'center') list.scrollTop = y - list.clientHeight / 2 + ROW_H / 2;
  else if (y < list.scrollTop) list.scrollTop = y;
  else if (y + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW_H - list.clientHeight;
  queueRender();
}

/* ---------------- now playing ---------------- */
function navPos(idx) {
  // 1-based position of idx inside navList (or the slot it would occupy)
  const p = lowerBound(navList, idx);
  return { pos: p + 1, exact: navList[p] === idx };
}

function renderNow() {
  const v = ALL[cur];
  if (!v) return;
  const { pos, exact } = navPos(cur);
  $('nowPos').textContent = exact
    ? `Video ${fmtNum(pos)} of ${fmtNum(navList.length)}`
    : `Not in current filter · #${fmtNum(cur + 1)} overall`;
  if (resumeNote && resumeNote.id === v.id) $('nowPos').textContent += ` · press play to resume at ${fmtDur(resumeNote.t)}`;
  $('nowTitle').textContent = v.title;
  const typeTag = v.type === 'short' ? '<span class="tag">Short</span>' : v.type === 'stream' ? '<span class="tag">Live stream</span>' : '';
  $('nowMeta').innerHTML = `<span class="badge ${v.ch}">${esc(CHANNEL_NAMES[v.ch])}</span>${typeTag}` +
    `<span${v.approx ? ' title="Estimated from neighbouring uploads; exact date not looked up yet"' : ''}>${v.approx && v.ts ? '≈ ' : ''}${fmtDateTime(v.ts)}</span>` +
    (v.dur ? `<span>${fmtDur(v.dur)}</span>` : '') +
    (isWatched(v) ? '<span>&#10003; watched</span>' : '');
  $('ytLink').href = `https://www.youtube.com/watch?v=${v.id}`;
  $('markBtn').textContent = isWatched(v) ? 'Mark unwatched' : 'Mark watched';
  $('prevBtn').disabled = neighbor(-1) === -1;
  $('nextBtn').disabled = neighbor(1) === -1;
  document.title = `${v.title} · RT Archive Viewer`;
}

function neighbor(dir) {
  if (!navList.length) return -1;
  if (dir > 0) {
    const p = lowerBound(navList, cur + 1);
    return p < navList.length ? navList[p] : -1;
  }
  const p = lowerBound(navList, cur) - 1;
  return p >= 0 ? navList[p] : -1;
}

/* ---------------- playback ---------------- */
function resumeTime(v) {
  const p = store.progress[v.id];
  if (!(p > 0)) return 0;
  if (v.dur && p > v.dur - 15) return 0; // basically finished: start over
  return Math.floor(p);
}

function playerVideoId() {
  try { return player.getVideoData()?.video_id || null; } catch { return null; }
}

// Record how far we got in the current video (called before switching away and periodically).
// Returns true if anything changed.
function recordProgress(final = false) {
  if (!playerReady) return false;
  const v = ALL[cur];
  if (!v || playerVideoId() !== v.id) return false;
  const st = player.getPlayerState();
  if (st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.PAUSED && st !== YT.PlayerState.BUFFERING) return false;
  const t = player.getCurrentTime();
  if (!(t > 0)) return false;
  const before = JSON.stringify([store.progress[v.id], store.current]);
  const dur = player.getDuration() || v.dur;
  if (store.progress[v.id] !== -1) {
    store.progress[v.id] = Math.floor(t);
    if (final && dur && t / dur >= WATCHED_FRACTION) store.progress[v.id] = -1;
  }
  store.current = { id: v.id, t: Math.floor(t) };
  return JSON.stringify([store.progress[v.id], store.current]) !== before;
}

// Another tab (storage event) or browser (server copy) saved newer progress: adopt it,
// so this tab never writes back stale data.
function adoptExternal(d) {
  if (!d || typeof d !== 'object' || (d.at || 0) <= store.at) return;
  const playing = playerReady && player.getPlayerState() === YT.PlayerState.PLAYING;
  mergeStore(d);
  $('autoNext').checked = store.settings.autoNext;
  $('autoSkip').checked = store.settings.autoSkip;
  $('hideEnd').checked = store.settings.hideEndscreens;
  if (!playing) rebuildPlayer();
  renderFilters();
  rebuildNav();
  const want = d.current && byId.has(d.current.id) ? byId.get(d.current.id) : cur;
  if (!playing && want !== cur) {
    const prev = cur;
    cur = want;
    resumeNote = resumeTime(ALL[cur]) > 0 ? { id: ALL[cur].id, t: resumeTime(ALL[cur]) } : null;
    hideOverlay();
    if (playerReady) player.cueVideoById({ videoId: ALL[cur].id, startSeconds: resumeTime(ALL[cur]) });
    refreshRow(prev);
    renderNow();
    scrollToIndex(cur, 'center');
  }
}

function select(idx, { autoplay = true, dir = 0, scroll = true } = {}) {
  if (idx < 0 || idx >= ALL.length) return;
  recordProgress(true);
  const prev = cur;
  cur = idx;
  if (dir) lastDir = dir;
  const v = ALL[cur];
  const start = resumeTime(v);
  store.current = { id: v.id, t: start };
  saveLocal();
  hideOverlay();
  resumeNote = null;
  if (playerReady) {
    if (autoplay) player.loadVideoById({ videoId: v.id, startSeconds: start });
    else player.cueVideoById({ videoId: v.id, startSeconds: start });
  }
  refreshRow(prev);
  refreshRow(cur);
  renderNow();
  renderStats();
  if (scroll) scrollToIndex(cur, 'nearest');
}

function togglePlay() {
  if (!playerReady) return;
  const st = player.getPlayerState();
  if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) player.pauseVideo();
  else player.playVideo();
}

function go(dir) {
  const n = neighbor(dir);
  if (n !== -1) select(n, { autoplay: true, dir });
}

function onStateChange(e) {
  const v = ALL[cur];
  if (e.data === YT.PlayerState.ENDED) {
    if (playerVideoId() === v.id || !playerVideoId()) {
      store.progress[v.id] = -1;
      store.current = { id: v.id, t: 0 };
      saveLocal();
      refreshRow(cur); renderNow(); renderStats();
    }
    if (store.settings.autoNext) {
      const n = neighbor(1);
      if (n !== -1) select(n, { autoplay: true, dir: 1 });
    }
  } else if (e.data === YT.PlayerState.PAUSED) {
    recordProgress();
    saveLocal();
    refreshRow(cur);
  } else if (e.data === YT.PlayerState.PLAYING) {
    hideOverlay();
    if (resumeNote) { resumeNote = null; renderNow(); }
    if (store.bad[v.id]) { delete store.bad[v.id]; refreshRow(cur); }
  }
}

function onError(e) {
  const v = ALL[cur];
  const code = e.data;
  store.bad[v.id] = code;
  saveLocal();
  refreshRow(cur);
  showOverlay(v, code);
}

function showOverlay(v, code) {
  $('overlay').classList.remove('hidden');
  $('overlayMsg').textContent = ERROR_TEXT[code] || `YouTube error ${code}.`;
  $('overlayYt').href = `https://www.youtube.com/watch?v=${v.id}`;
  const target = neighbor(lastDir) !== -1 ? lastDir : (neighbor(1) !== -1 ? 1 : -1);
  const label = target > 0 ? 'Skip to next' : 'Back to previous';
  clearInterval(skipTimer); skipTimer = null;
  $('overlayCancel').classList.add('hidden');
  $('overlaySkip').textContent = label;
  $('overlaySkip').onclick = () => go(target);
  if (store.settings.autoSkip && code !== 153 && neighbor(target) !== -1) {
    let left = SKIP_COUNTDOWN_S;
    $('overlaySkip').textContent = `${label} (${left})`;
    $('overlayCancel').classList.remove('hidden');
    skipTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(skipTimer); skipTimer = null; go(target); return; }
      $('overlaySkip').textContent = `${label} (${left})`;
    }, 1000);
  }
}

function hideOverlay() {
  clearInterval(skipTimer); skipTimer = null;
  $('overlay').classList.add('hidden');
}

// called by https://www.youtube.com/iframe_api
// YouTube's privacy-mode player (youtube-nocookie.com) doesn't draw end-screen cards, but it
// also doesn't use your YouTube login (no Premium / watch history inside the player).
const playerHost = () => (store.settings.hideEndscreens ? 'https://www.youtube-nocookie.com' : 'https://www.youtube.com');
let playerBuiltFor = null;

function createPlayer(autoplay = false, startAt = null) {
  const v = ALL[cur];
  playerReady = false;
  playerBuiltFor = playerHost();
  player = new YT.Player('player', {
      host: playerBuiltFor,
      width: '100%', height: '100%',
      videoId: v.id,
      playerVars: { start: startAt ?? resumeTime(v), autoplay: autoplay ? 1 : 0, rel: 0, playsinline: 1, origin: location.origin },
      events: {
        onReady: () => {
          playerReady = true;
          // the user may have picked another video while the player was loading
          const want = ALL[cur];
          if (playerVideoId() && playerVideoId() !== want.id) player.cueVideoById({ videoId: want.id, startSeconds: resumeTime(want) });
        },
        onStateChange,
        onError,
      },
  });
}

// Swap players (when the end-screen setting changes), keeping the video and position.
function rebuildPlayer() {
  if (!player || playerBuiltFor === playerHost()) return;
  const wasPlaying = playerReady && player.getPlayerState() === YT.PlayerState.PLAYING;
  // keep the exact spot (resumeTime() would restart a video that's in its last seconds)
  const at = playerReady && playerVideoId() === ALL[cur].id ? Math.floor(player.getCurrentTime()) : null;
  if (recordProgress()) saveLocal();
  try { player.destroy(); } catch {}
  if (!$('player')) {
    const div = document.createElement('div');
    div.id = 'player';
    document.querySelector('.player-wrap').prepend(div);
  }
  hideOverlay();
  createPlayer(wasPlaying, at);
}

window.onYouTubeIframeAPIReady = function () {
  if (ALL.length) createPlayer(); else window._startPlayer = () => createPlayer();
};

/* ---------------- UI wiring ---------------- */
function wire() {
  // keep the player sized to the space left under the top bar (it grows as filter chips wrap)
  const chrome = () => document.documentElement.style.setProperty('--chrome-h',
    `${document.querySelector('.topbar').offsetHeight + $('dataNote').offsetHeight}px`);
  new ResizeObserver(chrome).observe(document.querySelector('.topbar'));
  new ResizeObserver(chrome).observe($('dataNote'));
  chrome();
  $('prevBtn').onclick = () => go(-1);
  $('nextBtn').onclick = () => go(1);
  $('overlayCancel').onclick = () => { clearInterval(skipTimer); skipTimer = null; $('overlayCancel').classList.add('hidden'); $('overlaySkip').textContent = lastDir > 0 ? 'Skip to next' : 'Back to previous'; };
  $('toCurrent').onclick = () => scrollToIndex(cur, 'center');

  $('autoNext').checked = store.settings.autoNext;
  $('autoSkip').checked = store.settings.autoSkip;
  $('autoNext').onchange = (e) => { store.settings.autoNext = e.target.checked; saveLocal(); };
  $('autoSkip').onchange = (e) => { store.settings.autoSkip = e.target.checked; saveLocal(); };
  $('hideEnd').checked = store.settings.hideEndscreens;
  $('hideEnd').onchange = (e) => { store.settings.hideEndscreens = e.target.checked; saveLocal(); rebuildPlayer(); };

  $('markBtn').onclick = () => {
    const v = ALL[cur];
    if (isWatched(v)) delete store.progress[v.id]; else store.progress[v.id] = -1;
    saveLocal(); refreshRow(cur); renderNow(); renderStats();
  };

  const list = $('list');
  list.addEventListener('scroll', queueRender, { passive: true });
  window.addEventListener('resize', queueRender);
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const idx = +row.dataset.idx;
    select(idx, { autoplay: true, dir: idx >= cur ? 1 : -1, scroll: false });
  });

  let searchT;
  $('search').addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => {
      rebuildList();
      if ($('search').value.trim()) list.scrollTop = 0; else scrollToIndex(cur, 'center');
    }, 150);
  });

  $('dateJump').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const ts = new Date(e.target.value + 'T00:00:00').getTime() / 1000;
    const pos = lowerBound(listItems, ts, (i) => ALL[i].ts);
    list.scrollTop = Math.min(pos, Math.max(0, listItems.length - 1)) * ROW_H;
    queueRender();
  });

  // backup / restore
  $('menuBtn').onclick = (e) => { e.stopPropagation(); $('menu').classList.toggle('hidden'); };
  document.addEventListener('click', () => $('menu').classList.add('hidden'));
  $('exportBtn').onclick = () => {
    recordProgress();
    const blob = new Blob([JSON.stringify(store, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rt-viewer-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d || typeof d !== 'object' || !d.progress) throw new Error('not a progress file');
      importing = true;
      mergeStore(d);
      saveLocal();
      syncServer();
      location.reload();
    } catch (err) { alert('Could not import: ' + err.message); }
  };

  document.addEventListener('keydown', (e) => {
    // typing in the search / date boxes shouldn't trigger shortcuts (checkboxes are fine)
    if (e.target.matches('input:not([type=checkbox]), textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'k') { e.preventDefault(); if (!e.repeat) togglePlay(); }
    else if (k === 'n') { e.preventDefault(); go(1); }
    else if (k === 'p') { e.preventDefault(); go(-1); }
    else if (k === 'c') { e.preventDefault(); scrollToIndex(cur, 'center'); }
    else if (k === '/') { e.preventDefault(); $('search').focus(); }
  });

  // periodic saving
  setInterval(() => {
    if (!playerReady) return;
    if (player.getPlayerState() === YT.PlayerState.PLAYING && Date.now() - lastLocalSave >= SAVE_EVERY_MS - 50) {
      recordProgress();
      saveLocal();
    }
  }, SAVE_EVERY_MS);
  setInterval(() => { refreshRow(cur); }, 30000);
  setInterval(() => syncServer(), SERVER_SYNC_MS);
  // Only write when this tab actually changed something, so an idle tab never
  // overwrites newer progress saved elsewhere.
  const flush = () => { if (importing) return; if (recordProgress()) saveLocal(); syncServer(true); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { flush(); return; }
    adoptExternal(loadLocal());
    adoptExternal(await loadServer());
  });
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY && e.newValue) { try { adoptExternal(JSON.parse(e.newValue)); } catch {} }
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  const [res, server] = await Promise.all([fetch('data/videos.json', { cache: 'no-cache' }), loadServer()]);
  if (!res.ok) {
    $('nowTitle').textContent = 'data/videos.json missing — run: python3 scripts/build_data.py';
    return;
  }
  const data = await res.json();
  Object.assign(CHANNEL_NAMES, data.channels || {});
  const F = Object.fromEntries(data.fields.map((f, i) => [f, i]));
  ALL = data.videos.map((r, i) => ({
    id: r[F.id], title: r[F.title], ts: r[F.ts], dur: r[F.dur], ch: r[F.ch], type: r[F.type],
    flags: r[F.flags] || '', i, lc: r[F.title].toLowerCase(), approx: (r[F.flags] || '').includes('approx'),
  }));
  for (const v of ALL) {
    const tags = TITLE_FILTERS.filter((f) => (!f.channels || f.channels.includes(v.ch)) &&
      f.match.test(v.title) && !(f.exclude && f.exclude.test(v.title)));
    if (tags.length) v.tags = tags;
  }
  const approxCount = ALL.reduce((n, v) => n + v.approx, 0);
  if (approxCount) {
    const note = $('dataNote');
    note.textContent = `Exact upload dates known for ${fmtNum(ALL.length - approxCount)} of ${fmtNum(ALL.length)} videos; the rest are estimated (≈). The order sharpens as scripts/build_data.py finishes — reload to pick it up.`;
    note.classList.remove('hidden');
  }
  ALL.forEach((v) => byId.set(v.id, v.i));

  const local = loadLocal();
  mergeStore((server?.at || 0) > (local?.at || 0) ? server : local);

  cur = store.current && byId.has(store.current.id) ? byId.get(store.current.id) : 0;
  if (store.current && byId.has(store.current.id) && store.current.t > 0 && store.progress[store.current.id] !== -1) {
    store.progress[store.current.id] = Math.max(store.progress[store.current.id] || 0, store.current.t);
  }
  if (!store.current) store.current = { id: ALL[cur].id, t: 0 };
  if (resumeTime(ALL[cur]) > 0) resumeNote = { id: ALL[cur].id, t: resumeTime(ALL[cur]) };

  wire();
  renderFilters();
  rebuildNav();
  scrollToIndex(cur, 'center');
  if (window._startPlayer) window._startPlayer();
}

boot();
