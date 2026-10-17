/* ============================================================
   红果短剧 · 深夜剧场 — 前端 SPA
   视图：首页 / 推荐(Feed) / 分类 / 榜单 / 搜索 / 详情 / 播放器
   ============================================================ */
'use strict';

/* ---------------- 工具 ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = (u) => (u ? `/img?u=${encodeURIComponent(u)}` : '/img-fallback.svg');

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(x).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};

let toastTimer = null, toastHideTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.hidden = false;
  void el.offsetWidth; // 重放入场动画（连续提示也能平滑衔接）
  toastTimer = setTimeout(() => {
    el.classList.add('out');
    toastHideTimer = setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 280);
  }, 2600);
}

async function api(path) {
  const r = await fetch(path);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/* ---------------- 缓存（tab 切换免请求） ---------------- */
const mem = new Map();
function memoGet(key, ttl) {
  const v = mem.get(key);
  if (v && Date.now() - v.t < ttl) return v.data;
  return null;
}
function memoSet(key, data) { mem.set(key, { t: Date.now(), data }); }
function memoDrop(key) { mem.delete(key); }

function lsGet(key, ttl) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    if (v && Date.now() - v.t < ttl) return v.data;
  } catch {}
  return null;
}
function lsSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), data })); } catch {}
}

/* ---------------- 本地数据（进度/设置） ---------------- */
const store = {
  get progress() { try { return JSON.parse(localStorage.getItem('hg_progress') || '{}'); } catch { return {}; } },
  saveProgress(sid, rec) {
    const p = this.progress;
    p[sid] = { ...(p[sid] || {}), ...rec, updatedAt: Date.now() };
    localStorage.setItem('hg_progress', JSON.stringify(p));
  },
  getProgress(sid) { return this.progress[sid] || null; },
  removeProgress(sid) { const p = this.progress; delete p[sid]; try { localStorage.setItem('hg_progress', JSON.stringify(p)); } catch {} },
  clearProgress() { try { localStorage.setItem('hg_progress', '{}'); } catch {} },
  get settings() { try { return JSON.parse(localStorage.getItem('hg_settings') || '{}'); } catch { return {}; } },
  setSetting(k, v) { const s = this.settings; s[k] = v; localStorage.setItem('hg_settings', JSON.stringify(s)); },
};

function recordProgress(sid, name, cover, vid, epIndex, total, video) {
  if (!video || !video.duration || !isFinite(video.duration) || video.currentTime < 5) return;
  store.saveProgress(sid, {
    name, cover, vid,
    index: Math.max(1, epIndex + 1),
    total: total || 0,
    time: video.currentTime, dur: video.duration,
  });
}

/* ---------------- 集数预加载（切集连贯性） ---------------- */
const prewarm = new Map(); // vid → { el, url, mode, quality }

async function prefetchEpisode(vid, q) {
  if (!/^\d+$/.test(vid) || prewarm.has(vid)) return;
  try {
    const play = await api(`/api/play?vid=${encodeURIComponent(vid)}&q=${encodeURIComponent(q || '')}`);
    const el = document.createElement('video');
    el.preload = 'auto'; el.muted = true; el.src = play.url; el.load();
    prewarm.set(vid, { el, url: play.url, mode: play.mode, quality: play.quality });
    if (prewarm.size > 6) {
      const k0 = prewarm.keys().next().value;
      const e0 = prewarm.get(k0);
      e0.el.removeAttribute('src'); e0.el.load();
      prewarm.delete(k0);
    }
  } catch { /* 预热失败静默 */ }
}

function prefetchUpcoming(series, fromIdx, q, count = 2) {
  for (let k = 1; k <= count; k += 1) {
    const ep = series.episodes?.[fromIdx + k];
    if (ep) prefetchEpisode(ep.vid, q);
  }
}

/* ---------------- 剧目数据（失败不再缓存，可重试） ---------------- */
const seriesCache = new Map();
function getSeries(id) {
  if (!seriesCache.has(id)) {
    // 永远缓存 Promise 本身（而非解析后的值），保证任何时机调用都返回 thenable
    seriesCache.set(id, api(`/api/series/${id}`).catch((e) => { seriesCache.delete(id); throw e; }));
  }
  return seriesCache.get(id);
}

const HOME_TTL = 5 * 60 * 1000;
async function getHomeData() {
  const cached = memoGet('home', HOME_TTL);
  if (cached) return cached;
  const data = await api('/api/home');
  memoSet('home', data);
  return data;
}

/* ---------------- 路由 ---------------- */
const viewEl = $('#view');
let playerLayer = $('#player-layer');
let cleanups = [];

function onCleanup(fn) { cleanups.push(fn); }
function runCleanups() { cleanups.forEach((fn) => { try { fn(); } catch {} }); cleanups = []; }

function setHash(h) { if (location.hash !== h) location.hash = h; }
/** 替换当前历史记录（不新增），用于播放页内换集：浏览器退回直达上一页/详情页 */
function setHashReplace(h) {
  history.replaceState(history.state, '', h);
  router();
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, query: new URLSearchParams(qs || ''), seg: path.split('/').filter(Boolean) };
}

function resetLayer() {
  // 浅克隆替换节点：旧节点上的所有事件监听器随节点一起消亡，杜绝跨页面手势残留
  const fresh = playerLayer.cloneNode(false);
  fresh.innerHTML = '';
  playerLayer.replaceWith(fresh);
  playerLayer = fresh;
}

function router() {
  const { seg, query } = parseHash();
  runCleanups();
  destroyPlayer();
  resetLayer();
  updateNav(seg[0] || 'home');

  if (!seg.length) return viewHome();
  if (seg[0] === 'feed') return viewFeed();
  if (seg[0] === 'category') return viewCategory(seg[1] || 'comic-drama', /^[a-z-]+$/.test(seg[2] || '') ? seg[2] : '', Number(seg[2]) || Number(seg[3]) || 1);
  if (seg[0] === 'rank' && /^[a-z-]+$/.test(seg[1] || '')) return viewRank(seg[1]);
  if (seg[0] === 'history') return viewHistory();
  if (seg[0] === 'search' && seg[1]) return viewSearch(decodeURIComponent(seg[1]), Number(query.get('page') || 1));
  if (seg[0] === 'series' && /^\d+$/.test(seg[1] || '')) return viewSeries(seg[1]);
  if (seg[0] === 'play' && /^\d+$/.test(seg[1] || '') && /^\d+$/.test(seg[2] || '')) return viewPlay(seg[1], seg[2], query.get('q') || '');
  viewHome();
}

function updateNav(key) {
  const active = ({ home: 'home', feed: 'feed', category: 'category', rank: 'rank', history: 'history' })[key] || '';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === active && active !== ''));
}

function render(html) {
  viewEl.innerHTML = html;
  viewEl.classList.remove('v-enter');
  void viewEl.offsetWidth;
  viewEl.classList.add('v-enter');
  window.scrollTo(0, 0);
  return viewEl;
}

const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
const INFO_SVG = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>';

/** 进入播放页：优先续播记录，否则第 1 集；卡片点击时带加载态 */
async function playFromCard(cardEl, sid) {
  cardEl.classList.add('loading');
  try {
    const s = await getSeries(sid);
    const rec = store.getProgress(sid);
    const ep = (rec && s.episodes.find((x) => x.vid === rec.vid)) || s.episodes[0];
    if (!ep) throw new Error('该剧暂无可播分集');
    setHash(`#/play/${sid}/${ep.vid}?q=${encodeURIComponent(s.qualities[0]?.key || '')}`);
  } catch (e) {
    toast(e.message, 'err');
    setHash(`#/series/${sid}`);
  } finally {
    cardEl.classList.remove('loading');
  }
}

/* ---------------- 卡片 ---------------- */
function cardHTML(item, opts = {}) {
  const rankCls = opts.rank && opts.rank <= 3 ? ' top' : '';
  return `
  <a class="card ${opts.rank ? 'ranked' : ''}" href="#/series/${esc(item.id)}" data-sid="${esc(item.id)}" style="animation-delay:${Math.min((opts.i || 0) * 45, 400)}ms">
    <div class="poster">
      ${opts.rank ? `<span class="rank-no${rankCls}">${opts.rank}</span>` : ''}
      ${item.statusTags?.length ? `<div class="tags">${item.statusTags.slice(0, 1).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      <img src="${img(item.cover)}" alt="${esc(item.title)}" loading="lazy" onerror="this.src='/img-fallback.svg'">
      <span class="play-badge">${PLAY_SVG}</span>
      <button class="card-detail-btn" title="查看详情" data-detail="${esc(item.id)}">${INFO_SVG}</button>
      ${opts.resumeBar != null ? `<div class="resume-bar"><i style="width:${Math.min(100, opts.resumeBar)}%"></i></div>` : ''}
      ${opts.resumeEp ? `<span class="resume-ep">看到 ${esc(opts.resumeEp)}</span>` : ''}
    </div>
    <div class="t">${esc(item.title)}</div>
    <div class="r">${item.score ? `<b>${esc(item.score)}</b>` : ''}${item.score && (item.heat || item.remarks) ? ' · ' : ''}${esc(item.heat || (opts.resumeEp ? '' : item.remarks) || '')}</div>
  </a>`;
}

// 全局委托：资源卡片点击 → 直接进播放页；角标按钮 → 详情页
document.addEventListener('click', (ev) => {
  const detailBtn = ev.target.closest('.card-detail-btn');
  if (detailBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    setHash(`#/series/${detailBtn.dataset.detail}`);
    return;
  }
  const card = ev.target.closest('a.card[data-sid]');
  if (!card) return;
  ev.preventDefault();
  playFromCard(card, card.dataset.sid);
});

const skCards = (n, cls = '') => Array.from({ length: n }, () => `<div class="card ${cls}"><div class="sk sk-poster"></div><div class="sk sk-line"></div><div class="sk sk-line w60"></div></div>`).join('');

/* 剧名去季数："xx的第五季"/"xx 第2季" → "xx" */
function stripSeasonName(name) {
  const out = String(name || '')
    .replace(/第\s*[0-9零一二两三四五六七八九十百千]+\s*季/g, '')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[\s\-—·~：:，,]+$/g, '')
    .trim();
  return out || String(name || '');
}

/* 本季播完：右下角提示搜索同名剧集 */
function showFinishedTip(name) {
  playerLayer.querySelector('.feed-tipbox')?.remove();
  const q = stripSeasonName(name);
  const el = document.createElement('div');
  el.className = 'feed-tipbox';
  el.innerHTML = `
    <div class="ft-msg">《${esc(name)}》本季已播完</div>
    <div class="ft-actions">
      <button class="btn btn-red" data-q="${esc(q)}">搜索同名剧集</button>
      <button class="icon-btn ft-close" title="关闭"><svg class="stroke" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>`;
  playerLayer.appendChild(el);
  el.querySelector('[data-q]').addEventListener('click', () => {
    el.remove();
    setHash(`#/search/${encodeURIComponent(q)}`);
  });
  el.querySelector('.ft-close').addEventListener('click', () => el.remove());
  setTimeout(() => el.remove(), 25000);
}

function shelfHTML(title, cardsHtml, moreHref) {
  return `
  <section class="sec">
    <div class="sec-head"><h2>${esc(title)}</h2>${moreHref ? `<a class="more" href="${moreHref}">查看全部 →</a>` : ''}</div>
    <div class="rail-wrap"><div class="rail">${cardsHtml}</div><div class="rail-fade"></div></div>
  </section>`;
}

/* ---------------- 首页（缓存优先） ---------------- */
async function viewHome() {
  const cached = memoGet('home', HOME_TTL);
  if (!cached) {
    render(`<div class="page">
      <div class="sk sk-hero"></div>
      ${[1, 2].map(() => `<section class="sec"><div class="sk sk-line" style="width:170px;height:22px;margin:6px 0 16px"></div><div class="rail">${skCards(8)}</div></section>`).join('')}
    </div>`);
  }

  const continueItems = Object.entries(store.progress)
    .map(([sid, rec]) => ({ sid, ...rec }))
    .filter((r) => r.name && r.vid)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);

  let shelves;
  try { ({ shelves } = await getHomeData()); } catch (e) {
    render(`<div class="page"><div class="error-box"><div class="msg">内容加载失败：${esc(e.message)}</div><button class="btn btn-red" onclick="location.reload()">重新加载</button></div></div>`);
    return;
  }

  const top10 = (shelves[0]?.items || []).slice(0, 10);
  const heroHtml = top10.length ? `
  <section class="hero3d" id="hero">
    <div class="c3d-stage">
      ${top10.map((it, i) => `
      <div class="c3d-card" data-i="${i}">
        <img src="${img(it.cover)}" alt="${esc(it.title)}" onerror="this.src='/img-fallback.svg'">
        <div class="c3d-cap">
          <div class="c3d-kicker"><span class="flame">热榜 No.${i + 1}</span>${it.score ? `<span class="score">${esc(it.score)}</span>` : ''}</div>
          <div class="c3d-title">${esc(it.title)}</div>
          <div class="c3d-chips">${it.heat ? `<span class="chip hot">${esc(it.heat)}</span>` : ''}${(it.tags || []).slice(0, 2).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
          <div class="c3d-actions">
            <button class="btn btn-red hero-play-btn" data-id="${esc(it.id)}">${PLAY_SVG} 观看</button>
            <a class="btn btn-ghost" href="#/series/${esc(it.id)}">详情</a>
          </div>
        </div>
      </div>`).join('')}
    </div>
    <button class="hero-arrow" data-dir="prev" title="上一部"><svg class="stroke" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
    <button class="hero-arrow" data-dir="next" title="下一部"><svg class="stroke" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
    <div class="hero-dots">${top10.map((_, i) => `<button class="hero-dot ${i === 0 ? 'on' : ''}" data-i="${i}"></button>`).join('')}</div>
  </section>` : '';

  const continueHtml = continueItems.length ? shelfHTML('继续观看', continueItems.map((r, i) => cardHTML({
    id: r.sid, title: r.name, cover: r.cover,
  }, { i, resumeBar: r.dur ? (r.time / r.dur) * 100 : 0, resumeEp: `第${r.index}集` })).join(''), '') : '';

  const shelvesHtml = shelves.map((s, si) => shelfHTML(
    s.title,
    s.items.map((it, i) => cardHTML(it, { i, rank: si === 0 ? i + 1 : undefined, heat: si === 0 ? it.remarks : '' })).join(''),
    `#/rank/${s.key}`,
  )).join('');

  render(`<div class="page">${heroHtml}${continueHtml}${shelvesHtml}</div>`);

  // 3D 轮播：中心卡放大、两侧 3D 倾斜，自动轮换 + 悬停暂停
  const cards = $$('.c3d-card'), dots = $$('.hero-dot');
  let hi = 0, heroTimer = null;
  const n = cards.length;
  const layout3d = () => {
    hi = ((hi % n) + n) % n; // 归一化：负数/越界也能正确点亮圆点
    cards.forEach((card, i) => {
      let off = ((i - hi) % n + n) % n;
      if (off > n / 2) off -= n;
      const abs = Math.abs(off);
      card.style.opacity = abs <= 2 ? String(1 - abs * 0.3) : '0';
      card.style.zIndex = String(20 - abs);
      card.style.transform = `translate(-50%, -50%) translateX(${off * 64}%) rotateY(${off === 0 ? 0 : off < 0 ? 30 : -30}deg) scale(${off === 0 ? 1 : Math.max(0.7, 1 - abs * 0.12)})`;
      card.classList.toggle('center', off === 0);
    });
    dots.forEach((d, k) => d.classList.toggle('on', k === hi));
  };
  const heroAuto = () => { clearInterval(heroTimer); heroTimer = setInterval(() => { hi = (hi + 1) % n; layout3d(); }, 5000); };
  if (n > 1) {
    layout3d();
    heroAuto();
    $('#hero').addEventListener('mouseenter', () => clearInterval(heroTimer));
    $('#hero').addEventListener('mouseleave', heroAuto);
    $$('.hero-dot').forEach((d, k) => d.addEventListener('click', () => { hi = k; layout3d(); }));
    $$('.hero-arrow').forEach((a) => a.addEventListener('click', () => { hi = a.dataset.dir === 'prev' ? hi - 1 : hi + 1; layout3d(); }));
    $$('.c3d-card').forEach((c) => c.addEventListener('click', (ev) => {
      if (ev.target.closest('button,a')) return;
      const i = Number(c.dataset.i);
      if (i !== hi) { hi = i; layout3d(); }
    }));
    // 触控板横向滑动切换
    let wheelLock = 0;
    $('#hero').addEventListener('wheel', (ev) => {
      if (Math.abs(ev.deltaX) <= Math.abs(ev.deltaY) || Math.abs(ev.deltaX) < 24) return;
      const now = Date.now();
      if (now - wheelLock < 450) return;
      wheelLock = now;
      hi += ev.deltaX > 0 ? 1 : -1;
      layout3d();
    }, { passive: true });
    // 鼠标按住左右拖拽切换
    let dragStart = null;
    $('.c3d-stage').addEventListener('pointerdown', (ev) => { dragStart = { x: ev.clientX, y: ev.clientY }; });
    $('.c3d-stage').addEventListener('pointerup', (ev) => {
      if (!dragStart) return;
      const dx = ev.clientX - dragStart.x, dy = ev.clientY - dragStart.y;
      dragStart = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) { hi += dx < 0 ? 1 : -1; layout3d(); }
    });
    onCleanup(() => clearInterval(heroTimer));
  }
  $$('.hero-play-btn').forEach((btn) => btn.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const series = await getSeries(b.dataset.id);
      const rec = store.getProgress(series.id);
      const ep = (rec && series.episodes.find((x) => x.vid === rec.vid)) || series.episodes[0];
      setHash(`#/play/${series.id}/${ep.vid}?q=${encodeURIComponent(series.qualities[0]?.key || '')}`);
    } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  }));

  // 右下角：清除服务端数据缓存并刷新首页
  const cacheBtn = document.createElement('button');
  cacheBtn.className = 'cache-btn';
  cacheBtn.textContent = '清除服务器缓存';
  cacheBtn.addEventListener('click', async () => {
    cacheBtn.disabled = true;
    cacheBtn.textContent = '清除中…';
    try {
      const r = await api('/api/cache/clear');
      memoDrop('home');
      toast(`已清除 ${r.cleared} 条缓存，正在刷新…`);
      viewHome();
    } catch (e) {
      toast(e.message, 'err');
      cacheBtn.disabled = false;
      cacheBtn.textContent = '清除服务器缓存';
    }
  });
  document.body.appendChild(cacheBtn);
  onCleanup(() => cacheBtn.remove());
}

/* ---------------- 固定头 + 滚动区（分类/榜单共用） ---------------- */
function fixedPageShell(headHtml, bodyHtml) {
  return `
  <div class="fixed-page">
    <div class="fixed-head">${headHtml}</div>
    <div class="scroll-region">${bodyHtml}</div>
  </div>`;
}

function attachInfinite(region, sentinel, loadMore, onDone) {
  let busy = false, finished = false;
  const io = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || busy || finished) return;
    busy = true;
    try {
      const more = await loadMore();
      if (!more) { finished = true; onDone && onDone(); }
    } catch (e) { toast(e.message, 'err'); } finally { busy = false; }
  }, { root: region, rootMargin: '400px' });
  io.observe(sentinel);
  return { stop: () => io.disconnect() };
}

/* ---------------- 推荐 Feed（短视频交互） ---------------- */
const feed = { loadToken: 0, idx: -1, video: null, series: null, epIdx: 0, vid: '', list: [], muted: false, scrollTimer: null, states: new Map(), tagMaps: {} };

function destroyFeedVideo() {
  clearTimeout(feed.watchdog);
  if (feed.video) {
    try { feed.video.pause(); } catch {}
    feed.video.removeAttribute('src');
    feed.video.load();
    feed.video.remove();
    feed.video = null;
  }
}

function feedShowError(i, msg) {
  const slot = $(`#fv-${i}`);
  if (!slot) return;
  slot.innerHTML = `<div class="feed-error"><div class="fe-msg">${esc(msg)}</div><button class="btn btn-red" data-feedretry="${i}">重试</button></div>`;
}

async function viewFeed() {
  document.body.style.overflow = 'hidden';
  render('');
  playerLayer.className = 'player-layer feed-mode';
  playerLayer.innerHTML = `<div class="feed" id="feed-scroller"><div class="feed-tip" id="feed-tip">↑ ↓ 切换剧集 · ← → 切换集数 · 滚轮滑动 · Esc 退出</div></div>
    <div class="feed-ctrl" id="feed-ctrl">
      <div class="seek">
        <span class="tm" id="fc-cur">0:00</span>
        <div class="seek-track" id="fc-track">
          <div class="rail-bg"></div><div class="rail-buf" id="fc-buf"></div><div class="rail-play" id="fc-play"></div><div class="knob" id="fc-knob" style="left:0"></div>
        </div>
        <span class="tm" id="fc-dur">0:00</span>
      </div>
      <div class="ctrl-row">
        <button class="icon-btn" id="fc-toggle" title="播放/暂停 (空格)"><svg class="stroke" viewBox="0 0 24 24" id="fc-toggle-ic"><path d="M8 5v14M16 5v14"/></svg></button>
        <button class="icon-btn" id="fc-prev" title="上一集 (←)"><svg class="stroke" viewBox="0 0 24 24"><path d="M18 5v14L8 12zM6 5v14"/></svg></button>
        <button class="icon-btn" id="fc-next" title="下一集 (→)"><svg class="stroke" viewBox="0 0 24 24"><path d="M6 5v14l10-7zM18 5v14"/></svg></button>
        <div style="flex:1"></div>
        <button class="icon-btn" data-act="detail" title="查看详情"><svg class="stroke" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg></button>
        <button class="icon-btn" id="fc-mute" title="静音 (M)"><svg class="stroke" viewBox="0 0 24 24" id="fc-mute-ic"><path d="M4 9v6h4l5 4V5L8 9zM16 9c1.5 1.5 1.5 4.5 0 6"/></svg></button>
        <button class="btn btn-red feed-open-btn" data-act="open-play" title="进入播放页">进入播放页 →</button>
      </div>
    </div>`;
  // 兜底：初始化途中切走路由也能清屏
  onCleanup(() => {
    playerLayer.innerHTML = '';
    playerLayer.className = '';
    document.body.style.overflow = '';
  });

  // 列表优先用已缓存数据（首页/榜单拿过的直接复用）
  let shelves;
  try { shelves = (await getHomeData()).shelves; } catch (e) {
    playerLayer.innerHTML = `<div class="error-box" style="padding-top:30vh"><div class="msg">${esc(e.message)}</div><button class="btn btn-red" onclick="location.reload()">重试</button></div>`;
    return;
  }

  const seen = new Set();
  feed.list = [];
  const TYPE_BY_SHELF = {
    'hot-drama': 'real-drama', 'hot-real-drama': 'real-drama',
    'hot-comic-drama': 'comic-drama', 'hot-ai-drama': 'ai-drama',
  };
  for (const s of shelves) for (const it of s.items) {
    if (!seen.has(it.id)) { seen.add(it.id); feed.list.push({ ...it, type: TYPE_BY_SHELF[s.key] || 'real-drama' }); }
  }
  feed.list = feed.list.slice(0, 40);
  if (!feed.list.length) {
    playerLayer.innerHTML = '<div class="empty" style="padding-top:40vh"><div class="glyph">空</div>暂无推荐内容</div>';
    return;
  }

  // 预取各类型的“标签名 → 分类 slug”映射（点击标签跳分类页用）
  const tagMaps = feed.tagMaps;
  new Set(feed.list.map((d) => d.type)).forEach((type) => {
    if (tagMaps[type] || tagMaps[type + ':loading']) return;
    tagMaps[type + ':loading'] = true;
    api(`/api/category?type=${encodeURIComponent(type)}&page=1`).then((d) => {
      const m = {};
      for (const row of d.selectors || []) for (const it of row.items || []) m[it.name] = it.id;
      tagMaps[type] = m;
    }).catch(() => { tagMaps[type] = {}; });
  });

  const scroller = $('#feed-scroller');
  scroller.insertAdjacentHTML('beforeend', feed.list.map((d, i) => `
    <section class="feed-item" data-i="${i}">
      <div class="feed-bg"><img src="${img(d.cover)}" alt="" loading="lazy" onerror="this.style.display='none'"></div>
      <div class="feed-video-slot" id="fv-${i}"></div>
      <div class="feed-shade"></div>
      <div class="feed-overlay">
        <div class="feed-meta">
          <h3>${esc(d.title)}</h3>
          <div class="feed-chips">
            ${(d.tags || []).slice(0, 3).map((t) => `<button class="chip chip-link" data-act="tag" data-tag="${esc(t)}" data-i="${i}">${esc(t)}</button>`).join('')}
            ${d.remarks ? `<span class="chip hot">${esc(d.remarks)}</span>` : ''}
          </div>
          <div class="feed-ep" id="fep-${i}"></div>
        </div>
      </div>
      <div class="feed-loading" id="fl-${i}"><div class="feed-spinner"></div></div>
    </section>`).join(''));

  const mutedBtnSync = () => {
    const ic2 = $('#fc-mute-ic');
    const on = '<path d="M4 9v6h4l5 4V5L8 9zM16 9c1.5 1.5 1.5 4.5 0 6"/>';
    const off = '<path d="M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6"/>';
    if (ic2) ic2.innerHTML = feed.muted ? off : on;
  };

  /* -- 底部播放控件 -- */
  const fcToggleIc = $('#fc-toggle-ic');
  const fcSync = () => {
    const v = feed.video;
    if (fcToggleIc) fcToggleIc.innerHTML = (v && !v.paused) ? '<path d="M8 5v14M16 5v14"/>' : PLAY_SVG;
    mutedBtnSync();
  };
  const fcSeekUI = () => {
    const v = feed.video;
    if (!v || !v.duration || !isFinite(v.duration)) return;
    const pct = Math.min(100, (v.currentTime / v.duration) * 100);
    $('#fc-knob').style.left = $('#fc-play').style.width = pct + '%';
    $('#fc-cur').textContent = fmtTime(v.currentTime);
    $('#fc-dur').textContent = fmtTime(v.duration);
    if (v.buffered.length) $('#fc-buf').style.width = Math.min(100, (v.buffered.end(v.buffered.length - 1) / v.duration) * 100) + '%';
  };
  const fcTrack = $('#fc-track');
  let fcDrag = false;
  const fcSeekTo = (ev) => {
    const v = feed.video;
    if (!v || !v.duration || !isFinite(v.duration)) return;
    const r = fcTrack.getBoundingClientRect();
    v.currentTime = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * v.duration;
  };
  fcTrack.addEventListener('pointerdown', (ev) => { fcDrag = true; fcTrack.setPointerCapture(ev.pointerId); fcSeekTo(ev); });
  fcTrack.addEventListener('pointermove', (ev) => { if (fcDrag) fcSeekTo(ev); });
  fcTrack.addEventListener('pointerup', () => { fcDrag = false; });
  $('#fc-toggle').addEventListener('click', () => {
    const v = feed.video; if (!v) return;
    v.paused ? v.play().catch(() => {}) : v.pause();
  });
  $('#fc-prev').addEventListener('click', () => {
    if (feed.series && feed.epIdx > 0) playEpisode(feed.idx, feed.epIdx - 1); else toast('已经是第一集了');
  });
  $('#fc-next').addEventListener('click', () => {
    if (feed.series && feed.series.episodes[feed.epIdx + 1]) playEpisode(feed.idx, feed.epIdx + 1);
    else feedGoto(feed.idx + 1);
  });
  $('#fc-mute').addEventListener('click', () => {
    feed.muted = !feed.muted;
    if (feed.video) feed.video.muted = feed.muted;
    mutedBtnSync();
  });

  const saveNow = () => {
    if (feed.video && feed.series && feed.vid && feed.list[feed.idx]) {
      recordProgress(feed.list[feed.idx].id, feed.series.name, feed.list[feed.idx].cover, feed.vid, feed.epIdx, feed.series.episodes.length, feed.video);
    }
  };
  const saveTimer = setInterval(saveNow, 3000);
  window.addEventListener('beforeunload', saveNow);

  /** 预取后面几部剧的详情 + 首集播放地址 */
  function prefetchNextDramas(fromI, count = 2) {
    for (let j = fromI + 1; j <= fromI + count && j < feed.list.length; j += 1) {
      const nd = feed.list[j];
      getSeries(nd.id).then((ns) => {
        const nr = store.getProgress(nd.id);
        const nep = (nr && ns.episodes.find((x) => x.vid === nr.vid)) || ns.episodes[0];
        if (nep) prefetchEpisode(nep.vid, ns.qualities[0]?.key || '');
      }).catch(() => {});
    }
  }

  async function playEpisode(i, epIdx, { startAt = 0, isRetry = false } = {}) {
    const token = ++feed.loadToken;
    let retried = isRetry;
    clearTimeout(feed.watchdog);
    feed.idx = i;
    feed.epIdx = epIdx;
    destroyFeedVideo();
    $$('.feed-video-slot', playerLayer).forEach((el) => { if (el.id !== `fv-${i}`) el.innerHTML = ''; });
    $$('.feed-loading', playerLayer).forEach((el) => el.classList.remove('on'));

    const d = feed.list[i];
    const s = await getSeries(d.id).catch(() => null);
    if (!s) { if (token === feed.loadToken) feedShowError(i, '剧集数据加载失败'); return; }
    if (token !== feed.loadToken) return;
    const ep = s.episodes[epIdx];
    if (!ep) return feedGoto(i + 1); // 本部播完 → 下一部
    feed.series = s;
    feed.vid = ep.vid;
    feed.states.set(i, { s, epIdx });
    const fep = $(`#fep-${i}`);
    if (fep) fep.textContent = `第 ${ep.index} 集 · 共 ${s.episodes.length} 集`;
    const fl = $(`#fl-${i}`);
    fl && fl.classList.add('on');

    let play = null;
    const pre = prewarm.get(ep.vid);
    if (pre) { play = { url: pre.url, mode: pre.mode, quality: pre.quality }; prewarm.delete(ep.vid); }
    else {
      try { play = await api(`/api/play?vid=${encodeURIComponent(ep.vid)}&q=${encodeURIComponent(s.qualities[0]?.key || '')}`); } catch { /* 走错误分支 */ }
    }
    if (token !== feed.loadToken) { fl && fl.classList.remove('on'); return; }
    if (!play) {
      fl && fl.classList.remove('on');
      if (!retried) { retried = true; toast('解析失败，自动重试…'); setTimeout(() => playEpisode(i, epIdx, { startAt, isRetry: true }), 350); return; }
      feedShowError(i, '播放解析失败，请重试');
      return;
    }
    const slot = $(`#fv-${i}`);
    if (!slot || token !== feed.loadToken) return;

    const v = document.createElement('video');
    v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.volume = 1;
    v.muted = feed.muted; v.src = play.url; v.dataset.vid = ep.vid;
    if (store.settings.fit === 'cover') v.classList.add('fit-cover');
    slot.innerHTML = ''; slot.appendChild(v);
    feed.video = v;
    slot.querySelector('.feed-error')?.remove();

    // 播放状态可视化：暂停时的大播放键 + 静音提示 + 加载看门狗
    const bigBtn = document.createElement('button');
    bigBtn.className = 'feed-bigbtn';
    bigBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
    bigBtn.addEventListener('click', (ev) => { ev.stopPropagation(); v.play().catch(() => {}); });
    const soundPill = document.createElement('button');
    soundPill.className = 'feed-soundpill';
    soundPill.textContent = '声音已关闭 · 点击开启';
    soundPill.addEventListener('click', (ev) => {
      ev.stopPropagation();
      feed.muted = false; v.muted = false; mutedBtnSync();
      v.play().catch(() => {});
    });
    // 用内联 style 控制显隐（hidden 属性会被 CSS display 覆盖）
    const syncPlayUI = () => {
      bigBtn.style.display = v.paused ? 'grid' : 'none';
      soundPill.style.display = v.muted ? 'block' : 'none';
    };
    v.addEventListener('play', syncPlayUI);
    v.addEventListener('pause', syncPlayUI);
    v.addEventListener('volumechange', syncPlayUI);
    v.addEventListener('play', fcSync);
    v.addEventListener('pause', fcSync);
    v.addEventListener('volumechange', fcSync);
    v.addEventListener('timeupdate', fcSeekUI);
    slot.appendChild(bigBtn);
    slot.appendChild(soundPill);
    bigBtn.style.display = 'none'; // 元数据就绪前不显示，避免与加载圈重叠
    soundPill.style.display = 'none';

    clearTimeout(feed.watchdog);
    feed.watchdog = setTimeout(() => {
      if (token === feed.loadToken && (!feed.video || feed.video.readyState < 2)) {
        fl && fl.classList.remove('on');
        feedShowError(i, '加载超时（网络或上游受限），请重试或滚动换一部');
      }
    }, 15000);

    v.addEventListener('loadedmetadata', () => {
      if (token !== feed.loadToken) return;
      clearTimeout(feed.watchdog);
      fl && fl.classList.remove('on');
      syncPlayUI();
      if (startAt > 0 && startAt < v.duration - 10) v.currentTime = startAt;
      v.play().catch(() => {
        // 浏览器拦截有声自动播放：不再静音降级，停下等用户一键开启（点击即有声）
        v.pause();
        toast('浏览器拦截了自动播放，点击画面即可有声播放');
        syncPlayUI();
      });
    });
    v.addEventListener('timeupdate', () => recordProgress(d.id, s.name, d.cover, ep.vid, epIdx, s.episodes.length, v));
    v.addEventListener('click', () => { v.paused ? v.play().catch(() => {}) : v.pause(); });
    v.addEventListener('ended', () => {
      recordProgress(d.id, s.name, d.cover, ep.vid, epIdx, s.episodes.length, v);
      if (s.episodes[epIdx + 1]) playEpisode(i, epIdx + 1);
      else {
        showFinishedTip(s.name); // 本季播完：右下角提示搜同名（去季数），同时继续刷下一部
        feedGoto(i + 1);
      }
    });
    v.addEventListener('error', () => {
      clearTimeout(feed.watchdog);
      fl && fl.classList.remove('on');
      if (!retried) {
        retried = true;
        const at = isFinite(v.currentTime) && v.currentTime > 0 ? v.currentTime : startAt;
        toast('首次解析失败，自动重试…');
        setTimeout(() => playEpisode(i, epIdx, { startAt: at, isRetry: true }), 350);
      } else {
        feedShowError(i, '本集加载失败，请重试');
      }
    });
    // 显式像素适配：竖屏高度撑满、横屏宽度撑满（容器为控件条上方的剩余空间）
    const fitFeed = () => {
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return;
      const portrait = vh > vw;
      const cover = store.settings.fit === 'cover' && !portrait;
      const area = v.closest('.feed-video-slot');
      const W = (area && area.clientWidth) || window.innerWidth;
      const H = (area && area.clientHeight) || window.innerHeight;
      if (cover) {
        v.style.width = W + 'px'; v.style.height = H + 'px';
        v.style.objectFit = 'cover';
      } else {
        const sc = Math.min(W / vw, H / vh);
        v.style.width = Math.round(vw * sc) + 'px';
        v.style.height = Math.round(vh * sc) + 'px';
        v.style.objectFit = 'fill';
      }
    };
    v.addEventListener('loadedmetadata', fitFeed);
    if (feed.fitFeed) window.removeEventListener('resize', feed.fitFeed);
    feed.fitFeed = fitFeed;
    window.addEventListener('resize', fitFeed);

    // 预热：本剧后续两集 + 后面两部剧
    prefetchUpcoming(s, epIdx, s.qualities[0]?.key || '', 2);
    prefetchNextDramas(i, 2);
  }

  function feedGoto(i) {
    if (i < 0 || i >= feed.list.length) { toast('已经全部刷完啦'); return; }
    scroller.scrollTo({ top: i * scroller.clientHeight, behavior: 'smooth' });
  }

  function showAt(i, { startAt = 0 } = {}) {
    if (i < 0 || i >= feed.list.length) return;
    if (i === feed.idx && feed.video) return;
    const d = feed.list[i];
    const rec = store.getProgress(d.id);
    let resumeVid = null, resumeTime = 0;
    if (rec && rec.vid) {
      resumeVid = rec.vid;
      resumeTime = rec.time > 10 ? rec.time : 0;
    }
    feed.idx = i;
    getSeries(d.id).then((s) => {
      if (feed.idx !== i) return;
      const epIdx = resumeVid ? Math.max(0, s.episodes.findIndex((x) => x.vid === resumeVid)) : 0;
      playEpisode(i, epIdx, { startAt: resumeTime });
    }).catch(() => feedShowError(i, '剧集数据加载失败'));
  }

  scroller.addEventListener('scroll', () => {
    clearTimeout(feed.scrollTimer);
    feed.scrollTimer = setTimeout(() => {
      const i = Math.round(scroller.scrollTop / scroller.clientHeight);
      if (i !== feed.idx || !feed.video) showAt(i);
    }, 160);
  });

  playerLayer.addEventListener('click', (ev) => {
    const retry = ev.target.closest('[data-feedretry]');
    if (retry) {
      const i = Number(retry.dataset.feedretry);
      const st = feed.states.get(i);
      $(`#fv-${i}`)?.querySelector('.feed-error')?.remove();
      playEpisode(i, st ? st.epIdx : 0);
      return;
    }
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const i = feed.idx;
    if (btn.dataset.act === 'prev-ep') {
      if (feed.series && feed.epIdx > 0) playEpisode(i, feed.epIdx - 1); else toast('已经是第一集了');
    } else if (btn.dataset.act === 'next-ep') {
      if (feed.series && feed.series.episodes[feed.epIdx + 1]) playEpisode(i, feed.epIdx + 1);
      else feedGoto(i + 1);
    } else if (btn.dataset.act === 'mute') {
      feed.muted = !feed.muted;
      if (feed.video) feed.video.muted = feed.muted;
      mutedBtnSync();
    } else if (btn.dataset.act === 'open-play') {
      // 无缝移交到完整播放页：带上当前集与播放进度
      const s = feed.series, i = feed.idx;
      if (!s || !feed.vid) { toast('还在加载当前剧集'); return; }
      const t = feed.video && isFinite(feed.video.currentTime) ? Math.floor(feed.video.currentTime) : 0;
      recordProgress(feed.list[i].id, s.name, feed.list[i].cover, feed.vid, feed.epIdx, s.episodes.length, feed.video);
      setHash(`#/play/${feed.list[i].id}/${feed.vid}?q=${encodeURIComponent(s.qualities[0]?.key || '')}&t=${t}`);
    } else if (btn.dataset.act === 'tag') {
      // 标签 → 分类页：精确 slug → 模糊匹配；均无则转搜索
      const d = feed.list[Number(btn.dataset.i)] || feed.list[feed.idx];
      const type = d?.type || 'real-drama';
      const tag = btn.dataset.tag || '';
      const map = feed.tagMaps[type] || {};
      let slug = map[tag] || '';
      if (!slug) {
        const hit = Object.keys(map).find((n) => n.includes(tag) || tag.includes(n));
        if (hit) slug = map[hit];
      }
      if (slug) setHash(`#/category/${type}/${slug}/1`);
      else {
        toast(`「${tag}」暂无对应题材分类，已转搜索`);
        setHash(`#/search/${encodeURIComponent(tag)}`);
      }
    } else if (btn.dataset.act === 'detail') {
      setHash(`#/series/${feed.list[i].id}`);
    }
  });
  setTimeout(() => { const t = $('#feed-tip'); if (t) t.classList.add('bye'); }, 4200);

  const keyHandler = (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    switch (ev.key) {
      case 'ArrowUp': ev.preventDefault(); feedGoto(feed.idx - 1); break;
      case 'ArrowDown': ev.preventDefault(); feedGoto(feed.idx + 1); break;
      case 'ArrowLeft': ev.preventDefault();
        if (feed.series && feed.epIdx > 0) playEpisode(feed.idx, feed.epIdx - 1); else toast('已经是第一集了');
        break;
      case 'ArrowRight': ev.preventDefault();
        if (feed.series && feed.series.episodes[feed.epIdx + 1]) playEpisode(feed.idx, feed.epIdx + 1);
        else feedGoto(feed.idx + 1);
        break;
      case ' ': ev.preventDefault(); if (feed.video) feed.video.paused ? feed.video.play().catch(() => {}) : feed.video.pause(); break;
      case 'm': case 'M':
        feed.muted = !feed.muted;
        if (feed.video) feed.video.muted = feed.muted;
        mutedBtnSync();
        break;
      case 'Escape': history.back(); break;
    }
  };
  document.addEventListener('keydown', keyHandler);

  onCleanup(() => {
    clearInterval(saveTimer);
    if (feed.fitFeed) window.removeEventListener('resize', feed.fitFeed);
    window.removeEventListener('beforeunload', saveNow);
    document.removeEventListener('keydown', keyHandler);
    document.body.style.overflow = '';
    feed.loadToken += 1;
    destroyFeedVideo();
    playerLayer.innerHTML = '';
    playerLayer.className = '';
  });

  showAt(0, { startAt: 0 });
}

/* ---------------- 分类（固定头 + 触底加载 + 落盘缓存 15 分钟） ---------------- */
const CAT_TTL = 15 * 60 * 1000;
const catKey = (type, sub) => `hg_cat:${type}:${sub || 'all'}`;

function catLoad(type, sub) {
  return lsGet(catKey(type, sub), CAT_TTL) || { items: [], page: 0, totalPages: 1, total: 0, selectors: null };
}
function catSave(type, sub, state) {
  lsSet(catKey(type, sub), state); // 滚动写入即续期（滑动 15 分钟）
}

async function fetchCategoryPage(type, sub, page) {
  const ck = `catpage:${type}:${sub}:${page}`;
  const cached = memoGet(ck, CAT_TTL);
  if (cached) return cached;
  const data = await api(`/api/category?type=${encodeURIComponent(type)}&sub=${encodeURIComponent(sub)}&page=${page}`);
  memoSet(ck, data);
  return data;
}

async function viewCategory(type, sub, page) {
  const state = catLoad(type, sub);
  const types = [['comic-drama', '漫剧'], ['real-drama', '真人剧'], ['ai-drama', 'AI 剧']];

  const headHtml = `
    <div class="type-tabs">
      ${types.map(([slug, name]) => `<a class="type-tab ${slug === type ? 'on' : ''}" href="#/category/${slug}">${esc(name)}</a>`).join('')}
    </div>
    <div class="filter-row" id="cat-filters"><span class="filter-label">题材</span>
      <div class="filter-scroll">${state.selectors ? state.selectors[0]?.items.map((c) => `<a class="fchip ${c.id === sub ? 'on' : ''}" href="#/category/${esc(type)}/${esc(c.id)}">${esc(c.name)}</a>`).join('') : '<span class="sk sk-line" style="width:50%;height:26px"></span>'}</div>
    </div>`;

  const bodyHtml = state.items.length
    ? `<div class="grid" id="cat-grid">${state.items.map((it, i) => cardHTML(it, { i })).join('')}</div>`
    : `<div class="grid" id="cat-grid">${skCards(12)}</div>`;

  render(fixedPageShell(headHtml, `${bodyHtml}<div class="load-sentinel" id="cat-sentinel"><div class="load-line">加载中…</div></div>`));

  let st = state;
  let selectorsFetched = Boolean(state.selectors);
  let firstFill = !state.items.length; // 首屏是骨架，需替换而非追加

  async function loadMore() {
    const nextPage = st.page + 1;
    let data;
    try { data = await fetchCategoryPage(type, sub, nextPage); } catch (e) { return false; }
    if (!selectorsFetched && data.selectors?.length) {
      selectorsFetched = true;
      st.selectors = data.selectors;
      catSave(type, sub, st);
      const chips = [{ id: '', name: '全部' }, ...data.selectors[0].items];
      $('#cat-filters').innerHTML = '<span class="filter-label">题材</span><div class="filter-scroll">' + chips
        .map((c) => `<a class="fchip ${c.id === sub ? 'on' : ''}" href="#/category/${esc(type)}/${esc(c.id)}">${esc(c.name)}</a>`).join('') + '</div>';
    }
    if (!data.items.length) { st.totalPages = Math.min(st.totalPages || 1, st.page); catSave(type, sub, st); return false; }
    st.items = st.items.concat(data.items);
    st.page = nextPage;
    st.totalPages = data.totalPages || st.totalPages;
    st.total = data.total || st.total;
    catSave(type, sub, st);
    const cards = data.items.map((it, i) => cardHTML(it, { i })).join('');
    if (firstFill) { $('#cat-grid').innerHTML = cards; firstFill = false; }
    else $('#cat-grid').insertAdjacentHTML('beforeend', cards);
    updateCount();
    return st.page < st.totalPages;
  }

  function updateCount() {
    const el = $('#cat-count');
    if (el) el.textContent = `已加载 ${st.items.length}${st.total ? ` / 约 ${st.total}` : ''} 部`;
  }

  if (st.items.length) { updateCount(); loadMore(); } // 已有缓存则后台补一页
  else await loadMore();

  const stop = attachInfinite($('.scroll-region'), $('#cat-sentinel'), loadMore, () => {
    $('#cat-sentinel').innerHTML = '<div class="load-line">已经到底了</div>';
  });
  onCleanup(stop);
}

/* ---------------- 榜单（固定头 + 触底加载 + 会话缓存） ---------------- */
const rankStates = {}; // route → { items, page, totalPages }

function rankRowHTML(it, n) {
  return `
  <a class="rank-row" href="#/series/${esc(it.id)}" data-sid="${esc(it.id)}" style="animation-delay:${Math.min(n * 26, 320)}ms">
    <span class="no ${n <= 3 ? 'top' : ''}">${n}</span>
    <img src="${img(it.cover)}" alt="" loading="lazy" onerror="this.src='/img-fallback.svg'">
    <div class="m">
      <div class="t">${esc(it.title)}</div>
      <div class="d">${it.heat ? `<span class="heat">${esc(it.heat)}</span>` : ''}${it.remarks ? `<span>${esc(it.remarks)}</span>` : ''}${(it.tags || []).slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
    </div>
    ${it.score ? `<span class="score">${esc(it.score.replace('评分', ''))}</span>` : ''}
  </a>`;
}

async function viewRank(route) {
  const titles = { 'hot-drama': '红果热播榜', 'hot-real-drama': '真人剧热播榜', 'hot-comic-drama': '漫剧热播榜', 'hot-ai-drama': 'AI 剧热播榜' };
  if (!rankStates[route]) rankStates[route] = { items: [], page: 0, totalPages: 1 };

  const headHtml = `
    <div class="sec-head" style="margin:0"><h2>${esc(titles[route] || '榜单')}</h2></div>`;
  const bodyHtml = rankStates[route].items.length
    ? `<div class="rank-list" id="rk-list">${rankStates[route].items.map((it, i) => rankRowHTML(it, i + 1)).join('')}</div>`
    : `<div class="rank-list" id="rk-list">${Array.from({ length: 12 }, () => `<div class="rank-row"><span class="sk sk-line" style="width:46px;height:40px;border-radius:8px"></span><span class="sk" style="width:44px;height:58px;border-radius:6px"></span><div class="m" style="flex:1"><div class="sk sk-line w60"></div><div class="sk sk-line w40"></div></div></div>`).join('')}</div>`;

  render(fixedPageShell(headHtml, `${bodyHtml}<div class="load-sentinel" id="rk-sentinel"><div class="load-line">加载中…</div></div>`));

  const st = rankStates[route];
  let firstFill = !st.items.length; // 列表当前是骨架屏，首页数据到位后应替换而非追加

  async function loadMore() {
    const nextPage = st.page + 1;
    let data;
    try { data = await api(`/api/rank?route=${encodeURIComponent(route)}&page=${nextPage}`); } catch (e) { return false; }
    if (!data.items.length) return false;
    st.items = st.items.concat(data.items);
    st.page = nextPage;
    st.totalPages = data.totalPages || st.totalPages;
    const rows = data.items.map((it, i) => rankRowHTML(it, (nextPage - 1) * 20 + i + 1)).join('');
    if (firstFill) { $('#rk-list').innerHTML = rows; firstFill = false; }
    else $('#rk-list').insertAdjacentHTML('beforeend', rows);
    return st.page < st.totalPages;
  }

  if (st.items.length) { } else await loadMore();

  const stop = attachInfinite($('.scroll-region'), $('#rk-sentinel'), loadMore, () => {
    $('#rk-sentinel').innerHTML = '<div class="load-line">已经到底了</div>';
  });
  onCleanup(stop);
}

/* ---------------- 观看历史（全部） ---------------- */
async function viewHistory() {
  const entries = Object.entries(store.progress)
    .map(([sid, rec]) => ({ sid, ...rec }))
    .filter((r) => r.name && r.vid)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  render(fixedPageShell(
    `<div class="sec-head" style="margin:0"><h2>观看历史</h2><a class="more">共 ${entries.length} 部</a>${entries.length ? '<button class="btn btn-ghost" id="his-clear" style="margin-left:auto;height:32px;padding:0 12px;font-size:12px">清空全部</button>' : ''}</div>`,
    `${entries.length ? `<div class="grid" id="his-grid">${entries.map((r, i) => `
      <a class="card" href="#/play/${esc(r.sid)}/${esc(r.vid)}" data-sid="${esc(r.sid)}" style="animation-delay:${Math.min(i * 35, 350)}ms">
        <div class="poster">
          <img src="${img(r.cover)}" alt="${esc(r.name)}" loading="lazy" onerror="this.src='/img-fallback.svg'">
          <span class="play-badge">${PLAY_SVG}</span>
          <div class="resume-bar"><i style="width:${r.dur ? Math.min(100, (r.time / r.dur) * 100) : 0}%"></i></div>
          <span class="resume-ep">第${r.index}集 · ${fmtTime(r.time)}</span>
          <button class="card-detail-btn his-del" data-del="${esc(r.sid)}" title="删除该记录"><svg class="stroke" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
        <div class="t">${esc(r.name)}</div>
        <div class="r">${r.total ? `共 ${r.total} 集` : ''}${r.total && r.index ? ' · ' : ''}第 ${r.index} 集</div>
      </a>`).join('')}</div>` : '<div class="empty"><div class="glyph">空</div>还没有观看记录，去看一部剧吧</div>'}<div style="height:36px"></div>`)
  );

  $('#his-clear')?.addEventListener('click', () => {
    store.clearProgress();
    toast('已清空全部观看记录');
    viewHistory();
  });
  $$('.his-del').forEach((b) => b.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    store.removeProgress(b.dataset.del);
    toast('已删除该记录');
    viewHistory();
  }));
}

/* ---------------- 搜索 ---------------- */
async function viewSearch(q, page) {
  const si = $('#search-input');
  if (si && si.value !== q) si.value = q;
  render(`<div class="page">
    <div class="sec-head"><h2>“${esc(q)}” 的搜索结果</h2></div>
    <div class="grid">${skCards(12)}</div>
  </div>`);
  let data;
  try { data = await api(`/api/search?q=${encodeURIComponent(q)}&page=${page}`); } catch (e) {
    render(`<div class="page"><div class="error-box"><div class="msg">${esc(e.message)}</div></div></div>`);
    return;
  }
  if (!data.items.length) {
    render(`<div class="page"><div class="sec-head"><h2>“${esc(q)}” 的搜索结果</h2></div><div class="empty"><div class="glyph">无</div>没有找到相关剧集，换个关键词试试</div></div>`);
    return;
  }
  render(`
  <div class="page">
    <div class="sec-head"><h2>“${esc(q)}” 的搜索结果</h2>${data.via === 'site' ? '<a class="more">官网搜索每次最多提供 10 部</a>' : ''}${data.total ? `<a class="more">共 ${data.total} 部</a>` : ''}</div>
    <div class="grid" id="search-grid">${data.items.map((it, i) => cardHTML(it, { i })).join('')}</div>
    <div class="pager"><button class="btn btn-ghost" id="more-btn" style="${data.via === 'site' ? 'display:none' : ''}">加载更多</button></div>
  </div>`);
  const grid = $('#search-grid');
  const moreBtn = $('#more-btn');
  moreBtn.addEventListener('click', async () => {
    moreBtn.disabled = true; moreBtn.textContent = '加载中…';
    try {
      const next = await api(`/api/search?q=${encodeURIComponent(q)}&page=${page + 1}`);
      if (!next.items.length) { moreBtn.style.display = 'none'; toast('没有更多了'); return; }
      grid.insertAdjacentHTML('beforeend', next.items.map((it, i) => cardHTML(it, { i })).join(''));
      moreBtn.textContent = '加载更多'; moreBtn.disabled = false;
      if (next.via === 'site' && next.total && (page + 1) * 10 >= next.total) moreBtn.style.display = 'none';
    } catch (e) { toast(e.message, 'err'); moreBtn.textContent = '加载更多'; moreBtn.disabled = false; }
  });
}

/* ---------------- 详情 ---------------- */
async function viewSeries(id) {
  render(`<div class="detail-hero">
    <div class="detail-body">
      <div class="sk detail-poster"></div>
      <div class="detail-info">
        <div class="sk sk-line" style="width:58%;height:36px;margin-bottom:16px"></div>
        <div class="detail-meta" style="margin-bottom:14px">
          <span class="sk" style="width:78px;height:28px;border-radius:8px;display:inline-block"></span>
          <span class="sk" style="width:64px;height:22px;border-radius:999px;display:inline-block"></span>
          <span class="sk" style="width:72px;height:22px;border-radius:999px;display:inline-block"></span>
          <span class="sk" style="width:96px;height:22px;border-radius:999px;display:inline-block"></span>
          <span class="sk" style="width:60px;height:22px;border-radius:999px;display:inline-block"></span>
        </div>
        <div class="sk sk-line" style="width:42%;margin-bottom:14px"></div>
        <div class="sk sk-line" style="width:94%"></div>
        <div class="sk sk-line" style="width:90%"></div>
        <div class="sk sk-line" style="width:64%"></div>
        <div class="detail-actions" style="margin-top:20px">
          <span class="sk" style="width:138px;height:42px;border-radius:999px;display:inline-block"></span>
          <span class="sk" style="width:112px;height:42px;border-radius:999px;display:inline-block"></span>
        </div>
      </div>
    </div>
  </div>
  <section class="episodes-sec">
    <div class="sk sk-line" style="width:150px;height:20px;margin-bottom:14px"></div>
    <div class="ep-grid">${Array.from({ length: 42 }, () => '<span class="sk" style="height:40px;border-radius:8px;display:block"></span>').join('')}</div>
  </section>`);
  let s;
  try { s = await getSeries(id); } catch (e) {
    render(`<div class="page"><div class="error-box"><div class="msg">${esc(e.message)}</div><button class="btn btn-red" onclick="location.reload()">重试</button></div></div>`);
    return;
  }
  const rec = store.getProgress(s.id);
  const resumeEp = rec ? s.episodes.find((e) => e.vid === rec.vid) : null;
  const firstTarget = resumeEp || s.episodes[0];
  const defaultQ = s.qualities[0]?.key || '';
  const currentIndex = resumeEp ? resumeEp.index : 0;
  const resumeT = resumeEp && rec.vid === firstTarget.vid && rec.time > 10 ? Math.floor(rec.time) : 0;

  const epBtn = (ep) => `<button class="ep-btn ${ep.index === currentIndex ? 'current' : (currentIndex && ep.index < currentIndex ? 'watched' : '')}" data-vid="${esc(ep.vid)}" data-t="${ep.index === currentIndex ? resumeT : 0}">${ep.index}</button>`;

  render(`
  <div class="detail-hero">
    <div class="detail-backdrop"><img src="${img(s.cover)}" alt="" onerror="this.style.display='none'"></div>
    <div class="detail-body">
      <div class="detail-poster"><img src="${img(s.cover)}" alt="${esc(s.name)}" onerror="this.src='/img-fallback.svg'"></div>
      <div class="detail-info">
        <h1>${esc(s.name)}</h1>
        <div class="detail-meta">
          ${s.social?.rating ? `<span class="rating"><span class="star">★</span><span class="num">${esc(s.social.rating)}</span><span class="cnt">${s.social.reviews ? esc(s.social.reviews) + ' 人评分' : ''}</span></span>` : ''}
          ${s.social?.hot ? `<span class="detail-hot">${esc(s.social.hot)}</span>` : ''}
          <span class="chip">${esc(s.remarks)}</span>
          <span class="chip hot">最高 ${esc((s.qualities[0]?.label) || '360P')}</span>
          ${s.status === 1 ? '<span class="chip hot">连载中</span>' : '<span class="chip">已完结</span>'}
        </div>
        <div class="detail-sub">${s.celebrities?.length ? `<b>主演</b>　${s.celebrities.map(esc).join(' / ')}　` : ''}${(s.tags || []).slice(0, 6).map((t) => `<span class="chip" style="margin-right:6px">${esc(t)}</span>`).join('')}</div>
        <p class="detail-intro">${esc(s.intro)}</p>
        <div class="detail-actions">
          <button class="btn btn-red" id="play-now" data-vid="${esc(firstTarget.vid)}" data-t="${resumeT}">${PLAY_SVG} ${resumeEp && resumeT ? `继续播放 第${resumeEp.index}集` : '立即播放'}</button>
          <a class="btn btn-ghost" href="#/feed">进推荐刷剧 →</a>
        </div>
      </div>
    </div>
  </div>
  <section class="episodes-sec">
    <div class="sec-head"><h2>选集</h2><a class="more">${s.episodes.length} 集 · 默认 ${esc((s.qualities[0]?.label) || '360P')}，可切换</a></div>
    <div class="ep-grid" id="ep-grid">${s.episodes.map(epBtn).join('')}</div>
  </section>
  ${s.recommendations?.length ? `<div class="page" style="padding-top:6px">${shelfHTML('看了又看', s.recommendations.map((it, i) => cardHTML(it, { i })).join(''), '')}</div>` : ''}
  `);

  const go = (vid, t = 0) => setHash(`#/play/${s.id}/${vid}?q=${encodeURIComponent(defaultQ)}&t=${t}`);
  $('#play-now')?.addEventListener('click', (e) => go(e.currentTarget.dataset.vid, Number(e.currentTarget.dataset.t || 0)));
  $$('.ep-btn').forEach((b) => b.addEventListener('click', () => go(b.dataset.vid, Number(b.dataset.t || 0))));
}

/* ---------------- 播放器 ---------------- */
let P = null;
const EP_CHUNK = 50;

function destroyPlayer() {
  if (!P) return;
  try { recordProgress(P.sid, P.series.name, P.series.cover, P.vid, P.epIndex, P.series.episodes.length, P.video); } catch {}
  clearInterval(P.saveTimer);
  document.removeEventListener('keydown', P.keyHandler);
  window.removeEventListener('resize', P.fitEl || (() => {}));
  document.body.style.overflow = '';
  playerLayer.innerHTML = '';
  playerLayer.className = '';
  try { P.video.pause(); } catch {}
  P.video.removeAttribute('src');
  P.video.load();
  P = null;
}

function applyFit(layer, video) {
  const portrait = video && video.videoHeight > video.videoWidth;
  const cover = store.settings.fit === 'cover' && !portrait; // 竖屏一律「适应」：高度撑满左右留黑
  layer.classList.toggle('fit-cover', cover);
  if (video) video.classList.toggle('fit-cover', cover);
}

async function viewPlay(sid, vid, q) {
  document.body.style.overflow = 'hidden';
  playerLayer.className = 'player-layer';
  playerLayer.innerHTML = '<div class="sk" style="position:absolute;inset:0;border-radius:0"></div><div class="sk-line" style="position:absolute;left:50%;top:50%;translate:-50% -50%;width:160px"></div>';
  // 兜底：初始化途中切走路由也能清屏
  onCleanup(() => { playerLayer.innerHTML = ''; playerLayer.className = ''; document.body.style.overflow = ''; });

  let s;
  try { s = await getSeries(sid); } catch (e) {
    playerLayer.innerHTML = `<div class="error-box" style="padding-top:30vh"><div class="msg">${esc(e.message)}</div><button class="btn btn-red" onclick="history.back()">返回</button></div>`;
    return;
  }
  const epIndex = Math.max(0, s.episodes.findIndex((e) => e.vid === vid));
  const ep = s.episodes[epIndex];
  const queryT = Number(parseHash().query.get('t') || 0);
  const rec = store.getProgress(sid);
  const resumeTime = queryT > 0 ? queryT : (rec && rec.vid === vid && rec.time > 10 ? rec.time : 0);

  let play = null;
  const pre = prewarm.get(vid);
  if (pre) { play = { mode: pre.mode, quality: pre.quality, url: pre.url }; prewarm.delete(vid); }
  else {
    try { play = await api(`/api/play?vid=${encodeURIComponent(vid)}&q=${encodeURIComponent(q || '')}`); } catch { /* 统一报错 */ }
  }
  if (!play) {
    playerLayer.innerHTML = `<div class="error-box" style="padding-top:28vh"><div class="msg">播放解析失败，请稍后重试</div><button class="btn btn-red" onclick="location.reload()">重试</button><button class="btn btn-ghost" style="margin-left:10px" onclick="history.back()">返回</button></div>`;
    return;
  }

  const chunkCount = Math.ceil(s.episodes.length / EP_CHUNK);

  playerLayer.innerHTML = `
  <div class="player-video-wrap"><video id="pv" playsinline preload="auto" src="${esc(play.url)}"></video></div>
  <div class="player-ui">
    <div class="player-top">
      <button class="icon-btn" id="p-back" title="返回 (Esc)"><svg class="stroke" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="player-title">
        <div class="t">${esc(s.name)}</div>
        <div class="s">第 ${ep.index} 集 · <b>${esc(play.quality)}</b>${play.mode === 'web' ? ' · 官网直连' : ''}</div>
      </div>
      <div style="flex:1"></div>
      <button class="icon-btn" id="p-drawer" title="选集"><svg class="stroke" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg></button>
    </div>
    <div class="player-center" style="position:absolute;inset:0;display:grid;place-items:center;pointer-events:none">
      <button class="icon-btn" id="p-bigplay" style="width:76px;height:76px;pointer-events:auto;display:none" title="播放"><svg viewBox="0 0 24 24" style="width:30px;height:30px;margin-left:4px"><path d="M8 5.5v13l11-6.5z"/></svg></button>
    </div>
    <div class="player-bottom">
      <div class="seek">
        <span class="tm" id="p-cur">0:00</span>
        <div class="seek-track" id="p-track">
          <div class="rail-bg"></div><div class="rail-buf" id="p-buf"></div><div class="rail-play" id="p-play"></div><div class="knob" id="p-knob" style="left:0"></div>
        </div>
        <span class="tm" id="p-dur">0:00</span>
      </div>
      <div class="ctrl-row">
        <button class="icon-btn" id="p-toggle" title="播放/暂停 (空格)"><svg class="stroke" viewBox="0 0 24 24" id="p-toggle-ic"><path d="M8 5v14M16 5v14"/></svg></button>
        <button class="icon-btn" id="p-prev" title="上一集 (↑ / P / 滚轮上)"><svg class="stroke" viewBox="0 0 24 24"><path d="M18 5v14L8 12zM6 5v14"/></svg></button>
        <button class="icon-btn" id="p-next" title="下一集 (↓ / N / 滚轮下)"><svg class="stroke" viewBox="0 0 24 24"><path d="M6 5v14l10-7zM18 5v14"/></svg></button>
        <button class="icon-btn" id="p-vol" title="静音 (M)"><svg class="stroke" viewBox="0 0 24 24" id="p-vol-ic"><path d="M4 9v6h4l5 4V5L8 9zM16 9c1.5 1.5 1.5 4.5 0 6"/></svg></button>
        <input type="range" id="p-vol-range" class="vol-range" min="0" max="100" step="1" value="100" title="音量">
        <div class="spacer"></div>
        <button class="ctrl-label" id="p-speed">1x</button>
        <button class="ctrl-label" id="p-quality">${esc(play.quality)}</button>
        <button class="ctrl-label" id="p-fit">${store.settings.fit === 'cover' ? '铺满' : '适应'}</button>
        <button class="ctrl-label" id="p-autonext" title="自动连播">连播</button>
        <button class="icon-btn" id="p-full" title="全屏 (F)"><svg class="stroke" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
      </div>
    </div>
    <aside class="drawer" id="p-drawer-el">
      <div class="drawer-head">
        <img class="drawer-cover" src="${img(s.cover)}" alt="" onerror="this.src='/img-fallback.svg'">
        <div class="drawer-headinfo">
          <h3>${esc(s.name)}</h3>
          <div class="d-sub">${esc(s.remarks)} · ${esc(s.tags?.slice(0, 3).join(' / ') || '')}</div>
        </div>
        <button class="icon-btn" id="p-drawer-close"><svg class="stroke" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      ${s.intro ? `<div class="drawer-intro">${esc(s.intro)}</div>` : ''}
      ${chunkCount > 1 ? `<div class="chunk-tabs" id="p-chunks"></div>` : ''}
      <div class="drawer-body"><div class="ep-grid" id="p-eps"></div></div>
    </aside>
  </div>`;

  // fit 设置迁移：竖屏永远高度撑满，旧设置只对横屏生效
  if (!localStorage.getItem('hg_fit_v2')) {
    try { const st = { ...store.settings }; delete st.fit; localStorage.setItem('hg_settings', JSON.stringify(st)); } catch {}
    localStorage.setItem('hg_fit_v2', '1');
  }
  const video = $('#pv');
  const layer = playerLayer;
  applyFit(layer, video);
  video.muted = false;
  // 显式像素适配：不依赖浏览器 object-fit 的旋转/缩放怪癖
  const fitEl = () => {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const portrait = vh > vw;
    const cover = store.settings.fit === 'cover' && !portrait; // 竖屏永远高度撑满
    const W = layer.clientWidth || window.innerWidth;
    const H = layer.clientHeight || window.innerHeight;
    if (cover) {
      video.style.width = W + 'px'; video.style.height = H + 'px';
      video.style.objectFit = 'cover';
    } else {
      const sc = Math.min(W / vw, H / vh);
      video.style.width = Math.round(vw * sc) + 'px';
      video.style.height = Math.round(vh * sc) + 'px';
      video.style.objectFit = 'fill';
    }
  };
  video.addEventListener('loadedmetadata', fitEl);
  window.addEventListener('resize', fitEl);
  layer.addEventListener('fullscreenchange', () => setTimeout(fitEl, 80));
  onCleanup(() => window.removeEventListener('resize', fitEl));

  P = {
    sid, vid, q, mode: play.mode, epIndex, series: s, video,
    idleTimer: null, saveTimer: null, seekDrag: false, resumeTime,
    clickTimer: null, wheelLock: 0, keyHandler: null,
  };

  const speeds = [0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
  const tryPlay = () => video.play().catch(() => {});
  const togglePlay = () => (video.paused ? tryPlay() : video.pause());

  function updateToggleIcon() {
    $('#p-toggle-ic').innerHTML = video.paused ? PLAY_SVG : '<path d="M8 5v14M16 5v14"/>';
    $('#p-bigplay').style.display = video.paused ? 'grid' : 'none';
  }

  /** 换集/换清晰度：替换历史（浏览器退回直达进入播放器前的页面） */
  function gotoEpisode(nextVid, nextQ) {
    history.replaceState(history.state, '', `#/play/${sid}/${nextVid}?q=${encodeURIComponent(nextQ || q || '')}`);
    router();
  }
  function nextEp() {
    const next = s.episodes[epIndex + 1];
    if (!next) { toast('已经是最后一集了'); return false; }
    gotoEpisode(next.vid, q);
    return true;
  }
  function prevEp() {
    const prev = s.episodes[epIndex - 1];
    if (!prev) { toast('已经是第一集了'); return false; }
    gotoEpisode(prev.vid, q);
    return true;
  }

  /* -- 进度条 -- */
  const track = $('#p-track');
  const knob = $('#p-knob'), railPlay = $('#p-play'), railBuf = $('#p-buf');
  function seekUI() {
    const d = video.duration;
    if (!d || !isFinite(d)) return;
    const pct = Math.min(100, (video.currentTime / d) * 100);
    knob.style.left = railPlay.style.width = pct + '%';
    $('#p-cur').textContent = fmtTime(video.currentTime);
    $('#p-dur').textContent = fmtTime(d);
    if (video.buffered.length) {
      const end = video.buffered.end(video.buffered.length - 1);
      railBuf.style.width = Math.min(100, (end / d) * 100) + '%';
    }
  }
  const seekFromEvent = (ev) => {
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    if (video.duration && isFinite(video.duration)) video.currentTime = ratio * video.duration;
  };
  track.addEventListener('pointerdown', (ev) => { P.seekDrag = true; track.setPointerCapture(ev.pointerId); seekFromEvent(ev); });
  track.addEventListener('pointermove', (ev) => { if (P.seekDrag) seekFromEvent(ev); });
  track.addEventListener('pointerup', () => { P.seekDrag = false; });

  /* -- 视频事件 -- */
  video.addEventListener('loadedmetadata', () => {
    applyFit(layer, video); // 元数据就绪后按真实宽高比重设适配
    if (P.resumeTime > 0 && P.resumeTime < video.duration - 15) {
      video.currentTime = P.resumeTime;
      toast(`已从 ${fmtTime(P.resumeTime)} 继续播放`);
    }
    seekUI();
    prefetchUpcoming(s, epIndex, q || s.qualities[0]?.key || '', 2);
  });
  video.addEventListener('timeupdate', () => {
    seekUI();
    recordProgress(sid, s.name, s.cover, vid, epIndex, s.episodes.length, video);
  });
  video.addEventListener('progress', seekUI);
  video.addEventListener('play', updateToggleIcon);
  video.addEventListener('pause', updateToggleIcon);
  video.addEventListener('ended', () => {
    if (!s.episodes[epIndex + 1]) { showFinishedTip(s.name); return; }
    if (store.settings.autoNext !== false) {
      if (nextEp()) toast('自动播放下一集');
    }
  });
  video.addEventListener('waiting', () => layer.classList.add('buffering'));
  video.addEventListener('playing', () => layer.classList.remove('buffering'));
  video.addEventListener('error', () => {
    if (!video.src) return;
    const code = video.error ? video.error.code : '?';
    const names = { 1: '加载被中断', 2: '网络错误', 3: '解码失败', 4: '格式不支持' };
    console.error('[播放错误]', code, video.error && video.error.message);
    // 阶梯 1：清晰度切换后 10 秒内的解码失败 → 重载该清晰度（从头播放，规避 seek+HEVC 解码管线问题）
    if (P.lastSwitchAt && Date.now() - P.lastSwitchAt < 10000 && !P.switchRetried) {
      P.switchRetried = true;
      toast('切换后解码失败，已自动从头重试该清晰度', 'err');
      const u = video.src;
      video.removeAttribute('src');
      video.load();
      video.src = u;
      video.load();
      tryPlay();
      return;
    }
    // 阶梯 2：再次失败 → 回退官网 360P 直链（保证能看）
    if (P.lastSwitchAt && Date.now() - P.lastSwitchAt < 10000 && !P.webFallbackUsed) {
      P.webFallbackUsed = true;
      toast('该清晰度解码异常，已回退官网 360P 通道', 'err');
      video.src = `${location.origin}/web360/${vid}.mp4`;
      video.load();
      tryPlay();
      return;
    }
    toast(`视频加载失败（${names[code] || '未知错误 ' + code}），请重试或换一集`, 'err');
  });

  P.fitEl = fitEl;
  P.saveTimer = setInterval(() => { if (!video.paused) recordProgress(sid, s.name, s.cover, vid, epIndex, s.episodes.length, video); }, 3000);
  window.addEventListener('beforeunload', () => { if (P) recordProgress(sid, s.name, s.cover, vid, epIndex, s.episodes.length, video); });
  onCleanup(() => { if (P) recordProgress(sid, s.name, s.cover, vid, epIndex, s.episodes.length, video); });

  /* -- 控件 -- */
  $('#p-toggle').addEventListener('click', togglePlay);
  $('#p-bigplay').addEventListener('click', togglePlay);
  video.addEventListener('click', () => {
    clearTimeout(P.clickTimer);
    P.clickTimer = setTimeout(togglePlay, 240);
  });
  video.addEventListener('dblclick', () => {
    clearTimeout(P.clickTimer);
    $('#p-full').click();
  });
  $('#p-back').addEventListener('click', () => history.back());
  $('#p-next').addEventListener('click', nextEp);
  $('#p-prev').addEventListener('click', prevEp);
  $('#p-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else layer.requestFullscreen?.().catch(() => {});
  });

  const volRange = $('#p-vol-range');
  const syncVolUI = () => {
    const lvl = video.muted ? 0 : video.volume;
    $('#p-vol-ic').innerHTML = lvl === 0
      ? '<path d="M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6"/>'
      : '<path d="M4 9v6h4l5 4V5L8 9zM16 9c1.5 1.5 1.5 4.5 0 6"/>';
    volRange.style.setProperty('--fill', Math.round(lvl * 100) + '%'); // 拖动中也实时更新填充
    if (document.activeElement !== volRange) {
      volRange.value = Math.round(lvl * 100);
    }
  };
  const setVol = (v, fromSlider) => {
    video.volume = Math.min(1, Math.max(0, v));
    video.muted = video.volume === 0;
    if (!fromSlider) {
      volRange.value = Math.round(video.volume * 100);
      volRange.style.setProperty('--fill', Math.round(video.volume * 100) + '%');
    }
    syncVolUI();
  };
  volRange.addEventListener('input', () => {
    video.muted = false;
    setVol(volRange.value / 100, true);
  });
  $('#p-vol').addEventListener('click', () => setVol(video.muted || video.volume === 0 ? (P.lastVol || 1) : 0));
  video.addEventListener('volumechange', () => {
    if (video.volume > 0 && !video.muted) P.lastVol = video.volume;
    syncVolUI();
  });

  /* -- 鼠标滚轮切换上下集 -- */
  layer.addEventListener('wheel', (ev) => {
    if (P.seekDrag) return;
    if (drawer?.classList.contains('open')) return;
    if ($('.pop-menu', layer)) return;
    const now = Date.now();
    if (now - P.wheelLock < 900 || Math.abs(ev.deltaY) < 18) return;
    P.wheelLock = now;
    if (ev.deltaY > 0) nextEp(); else prevEp();
  }, { passive: true });

  /* -- 弹出菜单 -- */
  function popMenu(anchor, items, onPick, current) {
    $$('.pop-menu').forEach((m) => m.remove());
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'pop-menu';
    menu.style.bottom = window.innerHeight - rect.top + 10 + 'px';
    menu.style.left = Math.max(10, rect.left - 30) + 'px';
    menu.innerHTML = items.map((it) => `<button data-v="${esc(it.v)}" class="${String(it.v) === String(current) ? 'on' : ''}">${esc(it.label)}</button>`).join('');
    layer.appendChild(menu);
    menu.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (b) { onPick(b.dataset.v); menu.remove(); }
    });
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', close); } };
    setTimeout(() => document.addEventListener('pointerdown', close), 0);
  }

  const speedBtn = $('#p-speed');
  speedBtn.addEventListener('click', () => popMenu(speedBtn, speeds.map((v) => ({ v, label: v + 'x' })), (v) => {
    video.playbackRate = Number(v);
    speedBtn.textContent = v + 'x';
  }, String(video.playbackRate)));

  const qualityBtn = $('#p-quality');
  async function switchQuality(newQ) {
    // 原地切换：不重建播放器，保留播放进度与手势状态
    if (!newQ || newQ === q) return;
    const at = video.currentTime || 0;
    const wasPlaying = !video.paused;
    qualityBtn.textContent = '切换中…';
    let play = null;
    try { play = await api(`/api/play?vid=${encodeURIComponent(vid)}&q=${encodeURIComponent(newQ)}`); } catch { play = null; }
    if (!play) { toast('切换失败，请重试', 'err'); qualityBtn.textContent = String(q || '').toUpperCase(); return; }
    video.src = play.url;
    video.load();
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(at, video.duration || at);
      if (wasPlaying) tryPlay(); else updateToggleIcon();
      seekUI();
    }, { once: true });
    q = newQ;
    P.lastSwitchAt = Date.now();
    P.switchRetried = false;
    qualityBtn.textContent = play.quality;
    const st = $('.player-title .s');
    if (st) st.innerHTML = `第 ${ep.index} 集 · <b>${esc(play.quality)}</b>${play.mode === 'web' ? ' · 官网直连' : ''}`;
    history.replaceState(history.state, '', `#/play/${sid}/${vid}?q=${encodeURIComponent(newQ)}`);
    tryPlay();
  }
  if (s.qualities.length > 1) {
    qualityBtn.addEventListener('click', () => popMenu(qualityBtn,
      s.qualities.map((x) => ({ v: x.key, label: x.label + (x.key === 'web' ? '（官网）' : '') })),
      (v) => switchQuality(v),
      q || s.qualities[0]?.key));
  } else {
    qualityBtn.style.pointerEvents = 'none';
    qualityBtn.style.opacity = '.75';
  }

  const fitBtn = $('#p-fit');
  fitBtn.addEventListener('click', () => {
    const next = store.settings.fit === 'cover' ? 'contain' : 'cover';
    store.setSetting('fit', next);
    fitBtn.textContent = next === 'cover' ? '铺满' : '适应';
    applyFit(layer, video);
  });

  const autoBtn = $('#p-autonext');
  const syncAuto = () => autoBtn.classList.toggle('off', store.settings.autoNext === false);
  autoBtn.addEventListener('click', () => {
    store.setSetting('autoNext', store.settings.autoNext === false);
    syncAuto();
    toast(`自动连播已${store.settings.autoNext === false ? '关闭' : '开启'}`);
  });
  syncAuto();

  /* -- 选集抽屉（封面+简介 + 50 集分组） -- */
  const drawer = $('#p-drawer-el');
  let curChunk = Math.floor(epIndex / EP_CHUNK);
  function renderChunk() {
    const start = curChunk * EP_CHUNK;
    const end = Math.min(start + EP_CHUNK, s.episodes.length);
    $('#p-eps').innerHTML = s.episodes.slice(start, end).map((e) =>
      `<button class="ep-btn ${e.vid === vid ? 'current' : (e.index < ep.index ? 'watched' : '')}" data-vid="${esc(e.vid)}">${e.index}</button>`).join('');
    if (chunkCount > 1) {
      $('#p-chunks').innerHTML = Array.from({ length: chunkCount }, (_, c) => {
        const a = c * EP_CHUNK + 1, b = Math.min((c + 1) * EP_CHUNK, s.episodes.length);
        return `<button class="chunk-tab ${c === curChunk ? 'on' : ''}" data-chunk="${c}">${a}-${b}集</button>`;
      }).join('');
    }
  }
  if (chunkCount > 1) {
    $('#p-chunks').addEventListener('click', (ev) => {
      const b = ev.target.closest('.chunk-tab');
      if (!b) return;
      curChunk = Number(b.dataset.chunk);
      renderChunk();
    });
  }
  renderChunk();
  $('#p-drawer').addEventListener('click', () => drawer.classList.add('open'));
  $('#p-drawer-close').addEventListener('click', () => drawer.classList.remove('open'));
  $('#p-eps').addEventListener('click', (ev) => {
    const b = ev.target.closest('.ep-btn');
    if (!b) return;
    gotoEpisode(b.dataset.vid, q);
  });

  /* -- 闲置隐藏 -- */
  const wake = () => {
    layer.classList.remove('idle');
    clearTimeout(P.idleTimer);
    P.idleTimer = setTimeout(() => {
      if (!video.paused && !drawer.classList.contains('open') && !P.seekDrag) layer.classList.add('idle');
    }, 2600);
  };
  layer.addEventListener('pointermove', wake);
  layer.addEventListener('pointerdown', wake);
  wake();

  /* -- 触屏手势：上下滑切集，左右滑快进退 -- */
  let touchStart = null;
  layer.addEventListener('touchstart', (ev) => {
    if (ev.touches.length === 1) touchStart = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  layer.addEventListener('touchend', (ev) => {
    if (!touchStart) return;
    const dx = ev.changedTouches[0].clientX - touchStart.x;
    const dy = ev.changedTouches[0].clientY - touchStart.y;
    const dt = Date.now() - touchStart.t;
    touchStart = null;
    if (dt > 900) return;
    if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx) * 1.3) { dy < 0 ? nextEp() : prevEp(); return; }
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      video.currentTime = Math.max(0, Math.min(video.duration || 1e9, video.currentTime + (dx < 0 ? -10 : 10)));
      toast(dx < 0 ? '快退 10s' : '快进 10s');
    }
  }, { passive: true });

  /* -- 键盘：↑↓ 切集，←→ 快进退，M 静音 -- */
  P.keyHandler = (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    switch (ev.key) {
      case ' ': ev.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': video.currentTime = Math.max(0, video.currentTime - 5); wake(); break;
      case 'ArrowRight': video.currentTime = Math.min(video.duration || 1e9, video.currentTime + 5); wake(); break;
      case 'ArrowUp': ev.preventDefault(); prevEp(); break;
      case 'ArrowDown': ev.preventDefault(); nextEp(); break;
      case 'm': case 'M': $('#p-vol').click(); break;
      case 'n': case 'N': nextEp(); break;
      case 'p': case 'P': prevEp(); break;
      case 'f': case 'F': $('#p-full').click(); break;
      case 'Escape':
        if (drawer.classList.contains('open')) drawer.classList.remove('open');
        else if (document.fullscreenElement) document.exitFullscreen();
        else history.back();
        break;
    }
  };
  document.addEventListener('keydown', P.keyHandler);

  setVol(1);
  video.playbackRate = 1;
  tryPlay();
}

/* ---------------- 顶栏搜索 ---------------- */
function initSearch() {
  const input = $('#search-input');
  const box = $('#suggest');
  let timer = null;
  let seq = 0;

  const close = () => { box.hidden = true; box.innerHTML = ''; };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { close(); return; }
    timer = setTimeout(async () => {
      const mySeq = ++seq;
      try {
        const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (mySeq !== seq) return;
        if (!data.items.length) { close(); return; }
        box.innerHTML = data.items.slice(0, 8).map((it) => `
          <div class="suggest-item" data-id="${esc(it.id)}">
            <img src="${img(it.cover)}" alt="" onerror="this.src='/img-fallback.svg'">
            <span class="t">${esc(it.title)}</span>
            <span class="r">${esc(it.remarks || '')}</span>
          </div>`).join('');
        box.hidden = false;
        $$('.suggest-item', box).forEach((el) => el.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          close();
          setHash(`#/series/${el.dataset.id}`);
        }));
      } catch { close(); }
    }, 320);
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const q = input.value.trim();
      if (q) { close(); setHash(`#/search/${encodeURIComponent(q)}`); input.blur(); }
    } else if (ev.key === 'Escape') { close(); input.blur(); }
  });
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.searchbox')) close(); });
}

/* ---------------- 网页全屏 ---------------- */
/* ---------------- 榜单右缘渐隐 ---------------- */
function refreshRailFades() {
  $$('.rail').forEach((rail) => {
    const fade = rail.parentElement && rail.parentElement.querySelector('.rail-fade');
    if (!fade) return;
    const atEnd = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 8;
    fade.classList.toggle('off', atEnd || rail.scrollWidth <= rail.clientWidth + 4);
  });
}
function initRailFades() {
  document.addEventListener('scroll', (ev) => {
    if (ev.target && ev.target.classList && ev.target.classList.contains('rail')) refreshRailFades();
  }, true);
}

/* ---------------- 启动 ---------------- */
window.addEventListener('hashchange', router);
initSearch();
initRailFades();
router();
