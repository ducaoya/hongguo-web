#!/usr/bin/env node
/**
 * 红果短剧 · 网页版 — 本地服务
 *
 * 数据层：hongguoduanju.com 官网 SSR _ROUTER_DATA（分类/榜单/搜索/详情，免签名）
 *         + 番茄 App 签名接口（App 搜索兜底、视频模型）
 * 播放层：video_model → fallback_api → spade URL 解密 → CENC 分段解密的 Range 代理
 *
 * vendored 源: vendor/hongguo.cjs（未修改，GPL-3.0，见 vendor/NOTICE.md）
 * 本文件与前端为原创适配层，随项目按 GPL-3.0 提供。仅供个人本地学习使用。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const axios = require('axios');

const PORT = Number(process.env.PORT || 8630);
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })();
const DATA_TTL = 2 * 60 * 60 * 1000; // 第三方数据缓存统一 2 小时

/* ---------------- 日志（落盘 + 超长截断）与磁盘缓存 ---------------- */
const CACHE_DIR = process.env.HONGGUO_CACHE_DIR || path.join(os.homedir(), '.hongguo-web-cache');
const LOG_FILE = path.join(CACHE_DIR, 'server.log');
const LOG_MAX = 512 * 1024; // 超过则截断保留后半
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

function log(tag, msg) {
  const line = `[${new Date().toISOString()}] [${tag}] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) {
      const buf = fs.readFileSync(LOG_FILE);
      fs.writeFileSync(LOG_FILE, buf.subarray(buf.length - Math.floor(LOG_MAX / 2)));
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const DC_DIR = path.join(CACHE_DIR, 'dc');
const dfile = (key) => path.join(DC_DIR, crypto.createHash('md5').update(key).digest('hex') + '.json');

function dcacheGet(key, ttl) {
  try {
    const o = JSON.parse(fs.readFileSync(dfile(key), 'utf8'));
    if (Date.now() - o.t <= ttl) return o.data;
    fs.unlinkSync(dfile(key));
  } catch {}
  return null;
}

function dcacheSet(key, data) {
  try {
    fs.mkdirSync(DC_DIR, { recursive: true });
    fs.writeFileSync(dfile(key), JSON.stringify({ t: Date.now(), data }));
    const files = fs.readdirSync(DC_DIR).map((f) => ({ f, m: fs.statSync(path.join(DC_DIR, f)).mtimeMs }));
    if (files.length > 500) {
      files.sort((a, b) => a.m - b.m);
      for (const x of files.slice(0, files.length - 400)) { try { fs.unlinkSync(path.join(DC_DIR, x.f)); } catch {} }
    }
  } catch {}
}

function dcacheDel(key) { try { fs.unlinkSync(dfile(key)); } catch {} }
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SITE = 'https://hongguoduanju.com';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* 强制直连的 axios 包装（忽略环境变量代理，vendored 源内所有请求均走此实例） */
const directAxios = (configOrUrl, config = {}) => {
  const cfg = typeof configOrUrl === 'string' ? { ...config, url: configOrUrl } : { ...configOrUrl };
  cfg.proxy = false;
  return axios(cfg);
};
directAxios.get = (url, config = {}) => axios.get(url, { ...config, proxy: false });
directAxios.post = (url, data, config = {}) => axios.post(url, data, { ...config, proxy: false });

/* ---------------- 载入 vendored 红果源（签名/播放/解密能力） ---------------- */
const vendorSrc = fs.readFileSync(path.join(ROOT, 'vendor', 'hongguo.cjs'), 'utf8');
const factory = new Function(
  'require', 'axios', 'setResult', 'log',
  '"use strict";\n' + vendorSrc +
  '\n;return { appSearchPage, fetchVideoInfo, resolveStream, prepareHeader, remoteRange, decryptPartial, parseRangeHeader, qualityLabel, routerData, getText, deriveContentKey, cleanUrl, pageCache, appSearchCache, videoInfoCache, streamCache };'
);
const hg = factory(
  require,
  directAxios,
  (x) => x,
  (...args) => log('vendor', args.join(' ')),
);

/* ---------------- 基础工具 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendError(res, code, message) {
  sendJson(res, code, { error: String(message || 'unknown error') });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  const fallback = () => {
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e, data) => {
      if (e) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  };
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return fallback();
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (e2, data) => {
      if (e2) { res.writeHead(500); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache', // 本地服务零成本，杜绝旧脚本缓存导致的问题
      });
      res.end(data);
    });
  });
}

/* ---------------- 官网请求：排队 + 限速 + 壳页重试 ---------------- */
// 官网对突发请求会返回不含数据的壳页；串行排队 + 间隔，失败换 cache-bust 参数重试。
let siteQueue = Promise.resolve();
const SITE_GAP_MS = 600;

function enqueueSite(task) {
  const run = siteQueue.then(async () => {
    const result = await task();
    await sleep(SITE_GAP_MS);
    return result;
  });
  siteQueue = run.catch(() => {}); // 队列不因单次失败中断
  return run;
}

const textCache = new Map(); // url → { time, value }

async function getSiteText(url, { ttl = DATA_TTL, validate = null } = {}) {
  const dk = `html:${url}`;
  const cached = textCache.get(url);
  if (cached && Date.now() - cached.time < ttl) return cached.value;
  const disk = dcacheGet(dk, ttl);
  if (disk && (!validate || validate(disk))) { textCache.set(url, { time: Date.now(), value: disk }); return disk; }
  const html = await hg.getText(url);
  if (validate && !validate(html)) return html; // 壳页：不落盘，交给调用方重试
  textCache.set(url, { time: Date.now(), value: html });
  dcacheSet(dk, html);
  return html;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;|&#47;/gi, '/')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 官网 SSR 路由数据；壳页（缺 loaderData 数据键）自动重试 */
async function siteRouterData(pathAndQuery, { tries = 3 } = {}) {
  let lastErr = null;
  const dk = `ssr:${pathAndQuery}`;
  const disk = dcacheGet(dk, DATA_TTL);
  if (disk) return disk;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const bust = attempt === 0 ? '' : `${pathAndQuery.includes('?') ? '&' : '?'}_r=${Date.now()}-${attempt}`;
    try {
      const data = await enqueueSite(() => hg.routerData(`${SITE}${pathAndQuery}${bust}`));
      const ld = data?.loaderData || {};
      const dataKey = Object.keys(ld).find((k) => k !== 'category_layout' && !k.endsWith('_layout'));
      const page = dataKey ? ld[dataKey] : null;
      const ok = page && typeof page === 'object' && (
        Array.isArray(page.recommendList) && page.recommendList.length ||
        Array.isArray(page.searchList) ||
        page.seriesDetail ||
        (page.content && typeof page.content === 'object' && Array.isArray(page.content.rankList) && page.content.rankList.length)
      );
      if (ok) { dcacheSet(dk, page); return page; }
      lastErr = new Error('官网返回壳页');
    } catch (e) {
      lastErr = e;
      await sleep(1500);
    }
  }
  throw lastErr || new Error('官网数据不可用');
}

function cleanCover(url) {
  return String(url || '').replace(/\\\//g, '/').replace(/\\u0026/g, '&').trim();
}

/* ---------------- 榜单 ---------------- */

let homeCacheT = { time: 0, data: null };
let lastGoodHome = null;
const lastGoodShelves = new Map(); // route → 最后成功的榜单条目
const RANK_ROUTES = {
  'hot-drama': '红果热播榜',
  'hot-comic-drama': '漫剧热播榜',
  'hot-real-drama': '真人剧热播榜',
  'hot-ai-drama': 'AI 剧热播榜',
};

function parseRankHtml(html) {
  const m = html.match(/data-fn-name="r"[^>]*data-fn-args='([^']+)'/) ||
            html.match(/data-fn-name="r"[^>]*data-fn-args="([^"]+)"/);
  if (!m) throw new Error('榜单页面没有数据');
  const args = JSON.parse(decodeEntities(m[1]));
  const payload = Array.isArray(args) ? args[2] : null;
  if (!payload?.isSuccess || !Array.isArray(payload.rankList)) throw new Error('榜单数据格式错误');
  return payload;
}

function rankCard(item) {
  const id = String(item.seriesId || item.series_id || item.id || '');
  if (!id || !item.title) return null;
  return {
    id,
    title: String(item.title),
    cover: cleanCover(item.cover),
    remarks: item.heatText ? String(item.heatText) : '',
    rank: item.rank || null,
    score: item.scoreText ? String(item.scoreText) : '',
    statusTags: Array.isArray(item.statusTags) ? item.statusTags.map(String) : [],
    tags: Array.isArray(item.tags) ? item.tags.map((t) => t?.name || t).filter(Boolean).slice(0, 4) : [],
    intro: String(item.description || item.intro || ''),
  };
}

const rankItemCache = new Map(); // id → card，供搜索补充匹配

async function getRank(route, page = 1) {
  if (!RANK_ROUTES[route]) throw new Error('不支持的榜单');
  const suffix = page > 1 ? `?page=${page}` : '';
  let payload = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const html = await enqueueSite(() => getSiteText(`${SITE}/rank/${route}${suffix}`, { ttl: 1800000, validate: (h) => h.includes('data-fn-name="r"') }));
      payload = parseRankHtml(html);
      if (payload.rankList.length) break;
      if (page > 1) break; // 末页本来就可能是空
    } catch (e) {
      if (attempt === 3) throw e;
      textCache.delete(`${SITE}/rank/${route}${suffix}`);
      await sleep(2500 * (attempt + 1));
    }
  }
  const list = (payload?.rankList || []).map(rankCard).filter(Boolean);
  for (const c of list) {
    rankItemCache.set(c.id, c);
    if (rankItemCache.size > 800) rankItemCache.delete(rankItemCache.keys().next().value);
  }
  const pg = payload?.pagination || {};
  return {
    items: list,
    page: Number(pg.pageNum || page),
    totalPages: Number(pg.totalPages || 1),
  };
}

/* ---------------- 分类 ---------------- */

const CATEGORY_TYPES = [
  { slug: 'real-drama', name: '真人剧' },
  { slug: 'comic-drama', name: '漫剧' },
  { slug: 'ai-drama', name: 'AI 剧' },
];

function categoryCard(item) {
  const id = String(item.series_id || '');
  if (!id) return null;
  const tags = Array.isArray(item.category_list) ? item.category_list.map((v) => v?.name || v).filter(Boolean) : [];
  return {
    id,
    title: String(item.series_name || item.series_title || ''),
    cover: cleanCover(item.series_cover),
    remarks: String(item.episode_right_text || (item.episode_cnt ? `全${item.episode_cnt}集` : '')),
    tags: tags.slice(0, 4),
    intro: String(item.series_intro || ''),
  };
}

async function getCategory(typeSlug, subSlug, page = 1) {
  const type = CATEGORY_TYPES.find((t) => t.slug === typeSlug);
  if (!type) throw new Error('不支持的分类');
  const sub = subSlug && /^[a-z-]+$/.test(subSlug) ? `/${subSlug}` : '';
  const suffix = page > 1 ? `?page=${page}` : '';
  const data = await siteRouterData(`/category/${typeSlug}${sub}${suffix}`);
  const items = (data.recommendList || []).map(categoryCard).filter(Boolean);
  const pg = data.pagination || {};
  const selectors = (Array.isArray(data.selectorList) ? data.selectorList : []).map((row) => ({
    name: String(row.row_name || ''),
    items: (row.items || []).map((it) => ({ id: String(it.selector_item_id), name: String(it.show_name) })),
  }));
  return {
    type: typeSlug,
    typeName: type.name,
    sub: subSlug || '',
    items,
    page: Number(pg.pageNum || page),
    totalPages: Number(pg.totalPages || 1),
    total: Number(pg.total || 0),
    selectors,
  };
}

/* ---------------- 搜索 ---------------- */

async function getSearch(q, page = 1) {
  const ck = `search:${q}:${page}`;
  const cached = dcacheGet(ck, DATA_TTL);
  if (cached) return cached;
  let items = [];
  let total = 0;
  let via = 'app';
  try {
    // App 签名搜索（结果质量更好，无分页总数概念，用 hasMore 推断）
    const result = await hg.appSearchPage(q, 11, page, 30);
    items = (result.list || [])
      .filter((c) => c.url && c.title)
      .map((c) => ({
        id: String(c.url),
        title: String(c.title),
        cover: cleanCover(c.img),
        remarks: String(c.desc || ''),
        tags: String(c.tname || '').split('/').filter(Boolean).slice(0, 4),
        intro: String(c.content || ''),
      }));
  } catch (e) {
    via = 'site';
    log('search', `App 接口失败，回退官网: ${e.message}`);
    if (page > 1) {
      // 官网搜索不认翻页参数（固定只给前 10 条），页 > 1 直接返回空避免重复数据
      return { items: [], page, total: 0, via };
    }
    const data = await siteRouterData(`/search/${encodeURIComponent(q)}`);
    items = (data.searchList || []).map((cell) => {
      const v = cell?.video_data || {};
      return categoryCard(v) || null;
    }).filter(Boolean);
    total = Number(data.totalCount || 0);
    // 补充：热播榜缓存中标题命中该关键词的剧（官网单次只给 10 条）
    const have = new Set(items.map((i) => i.id));
    const supp = [...rankItemCache.values()].filter((c) => !have.has(c.id) && c.title.includes(q)).slice(0, Math.max(0, 14 - items.length));
    if (supp.length) items = items.concat(supp);
  }
  const out = { items, page, total, via };
  dcacheSet(ck, out);
  return out;
}

/* ---------------- 详情 ---------------- */

async function getSeries(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('bad series id');
  const data = await siteRouterData(`/detail?series_id=${encodeURIComponent(id)}`);
  const s = data.seriesDetail || {};
  const vids = (s.vid_list || []).map(String).filter(Boolean);
  if (!vids.length) throw new Error('该剧没有可用分集');

  const social0 = data.seriesSocialInfo || {};
  const social = {
    rating: social0.rating || null,
    hot: social0.hot_score_data?.text || '',
    likes: social0.series_like_count || '',
    reviews: social0.reviews?.total_count || '',
  };

  const recommendations = (Array.isArray(data.recommendations) ? data.recommendations : [])
    .map((item) => {
      const v = item?.video_data && typeof item.video_data === 'object' ? item.video_data : item;
      return categoryCard(v);
    })
    .filter(Boolean)
    .slice(0, 12);

  const celebrities = (Array.isArray(s.celebrities) ? s.celebrities : [])
    .map((c) => String(c?.name || '')).filter(Boolean).slice(0, 6);

  // 探测第一集可用清晰度（preload 接口；失败则只用官网公开 360P）
  let qualities = [];
  try {
    const rows = await preloadModel(vids[0]);
    qualities = rows.map((r) => ({ key: r.def || `${r.sw}p`, label: r.sw ? `${r.sw}P` : String(r.def || 'auto').toUpperCase() }));
  } catch (e) {
    log('probe', `高清探测失败，仅提供官网 360P 通道: ${e.message}`);
  }
  if (!qualities.length) qualities = [{ key: 'web', label: '360P' }];

  const tags = Array.isArray(s.tags)
    ? s.tags.map((t) => t?.name || t).filter(Boolean)
    : (Array.isArray(s.category_list) ? s.category_list.map((v) => v?.name || v) : []);

  return {
    id: String(s.series_id || id),
    name: String(s.series_name || s.series_title || ''),
    cover: cleanCover(s.series_cover),
    intro: String(s.series_intro || ''),
    remarks: String(s.episode_right_text || (s.episode_cnt ? `全${s.episode_cnt}集` : '')),
    tags: tags.slice(0, 8),
    celebrities,
    status: Number(s.series_episode_info?.series_status ?? 0),
    episodes: vids.map((vid, index) => ({ index: index + 1, vid, label: `第${index + 1}集` })),
    qualities,
    social,
    recommendations,
  };
}

/* ---------------- App 高清通道（preload 接口，免完整签名，最高 1080P） ---------------- */

const HD_API = 'https://api5-normal-sinfonlineb.fqnovel.com';
const HD_QUERY = {
  klink_egdi: 'AAI29o4dI-eMiO73_SRSbZ_0By1v3fUSriNeu8-L951MoXhWT88pzj5B',
  iid: '3788260546453235', device_id: '538083340353620', ac: 'wifi', channel: 'oppo_8662_64',
  aid: '8662', app_name: 'novelread', version_code: '71532', version_name: '7.1.5.32',
  device_platform: 'android', os: 'android', ssmix: 'a', device_type: 'SM-N9860', device_brand: 'Samsung',
  language: 'zh', os_api: '28', os_version: '9', manifest_version_code: '71532',
  resolution: '900*1600', dpi: '320', update_version_code: '71532', host_abi: 'arm64-v8a',
  dragon_device_type: 'pad', pv_player: '71532', compliance_status: '0', need_personal_recommend: '1',
  player_so_load: '1', is_android_pad_screen: '0', rom_version: 'PQ3A.190705.10241111+release-keys',
  cdid: 'b4f93387-5319-4134-aab9-2cd4e9279b8f',
};
const HD_HEADERS = {
  'User-Agent': 'com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)',
  'Accept-Encoding': 'gzip',
  'Accept': 'application/json; charset=utf-8,application/x-protobuf',
  'Content-Type': 'application/json; charset=utf-8',
};

const modelCache = new Map(); // vid → { time, rows }
const MODEL_TTL = 10 * 60 * 1000;

/** 请求视频模型（重试），返回按清晰度降序的 rows */
async function preloadModel(vid) {
  const cached = modelCache.get(vid);
  if (cached && Date.now() - cached.time < MODEL_TTL) return cached.rows;
  const dk = `vmodel:${vid}`;
  const disk = dcacheGet(dk, MODEL_TTL);
  if (disk) { modelCache.set(vid, { time: Date.now(), rows: disk }); return disk; }
  let lastErr = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      const body = {
        biz_param: { detail_page_version: 0, device_level: 3, disable_digg_stat: false, need_all_video_definition: true, need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024 },
        dr_scene: 'preload',
        mixed_video_id_map: { '1004': [String(vid)] },
      };
      const res = await axios.post(`${HD_API}/novel/player/multi_video_model/preload/v1`, body, {
        params: { ...HD_QUERY, _rticket: String(Date.now() + i) },
        headers: HD_HEADERS, timeout: 20000,
        responseType: 'arraybuffer', transformResponse: [(d) => d], proxy: false,
      });
      const buf = Buffer.from(res.data || []);
      if (res.status !== 200 || !buf.length) throw new Error(`HTTP ${res.status}${buf.length ? '' : ' 空响应'}`);
      const j = JSON.parse(buf.toString('utf8'));
      if (Number(j.code) !== 0) throw new Error(j.message || `code ${j.code}`);
      const raw = j.data?.[String(vid)]?.video_model;
      const vm = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const rows = (vm?.video_list || [])
        .filter((v) => v.main_url)
        .map((v) => ({
          def: String(v.video_meta?.definition || ''),
          h: Number(v.video_meta?.vheight || 0),
          w: Number(v.video_meta?.vwidth || 0),
          sw: Math.min(Number(v.video_meta?.vwidth || 0), Number(v.video_meta?.vheight || 0)), // 短边：横竖屏统一的质量口径
          url: String(v.main_url),
          spadeA: v.encrypt_info?.spade_a || null,
        }))
        .sort((a, b) => b.sw - a.sw);
      if (!rows.length) throw new Error('video_list 为空');
      modelCache.set(vid, { time: Date.now(), rows });
      dcacheSet(dk, rows);
      return rows;
    } catch (e) {
      lastErr = e;
      await sleep(700 * (i + 1));
    }
  }
  throw lastErr || new Error('video_model 获取失败');
}

const hdCache = new Map(); // 'vid|def' → { time, stream }
const HD_TTL = 8 * 60 * 1000;
const hdKey = (vid, def) => `${vid}|${def || 'best'}`;

/** 解析高清流：spade_a → CENC 内容密钥；CDN 地址动态调度，失败由调用方换节点重试 */
async function resolveHD(vid, def) {
  const key = hdKey(vid, def);
  const cached = hdCache.get(key);
  if (cached && Date.now() - cached.time < HD_TTL) return cached.stream;
  const rows = await preloadModel(vid);
  const row = (def && rows.find((r) => r.def === def)) || rows[0];
  if (!row) throw new Error('没有可用清晰度');
  const stream = {
    vid: String(vid),
    url: row.url,
    key: row.spadeA ? hg.deriveContentKey(row.spadeA) : null,
    quality: row.sw ? `${row.sw}P` : String(row.def || 'auto').toUpperCase(),
    def: row.def,
  };
  hdCache.set(key, { time: Date.now(), stream });
  return stream;
}

function normalizeDef(q) {
  const s = String(q || '').toLowerCase().trim();
  if (!s || s === 'auto' || s === 'best' || s === 'web') return '';
  return /^\d+p$/.test(s) ? s : '';
}

/**
 * 解析出“活着的”高清流：真正去拉 MP4 头验证 CDN 节点可用；
 * 死节点 → 清缓存重新调度（换一批 URL），最多 3 轮。保证调用方拿到可用流。
 */
async function resolveLiveStream(vid, def) {
  let lastErr = null;
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) {
      hdCache.delete(hdKey(vid, def));
      modelCache.delete(String(vid)); // 关键：丢弃旧调度结果，逼出新的 CDN 节点
      dcacheDel(`vmodel:${vid}`);
    }
    try {
      const stream = await resolveHD(vid, def);
      await hg.prepareHeader(stream); // 拉首段 256KB + 解析 moov —— 死节点在这里暴露
      return stream;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('无可用 CDN 节点');
}

async function handlePlay(res, u) {
  const vid = u.searchParams.get('vid') || '';
  const q = u.searchParams.get('q') || '';
  if (!/^\d+$/.test(vid)) return sendError(res, 400, 'bad vid');
  try {
    const stream = await resolveLiveStream(vid, normalizeDef(q));
    return sendJson(res, 200, {
      mode: 'hd',
      quality: stream.quality,
      encrypted: Boolean(stream.key),
      url: `/stream?vid=${encodeURIComponent(vid)}&q=${encodeURIComponent(stream.def || '')}`,
    });
  } catch (e) {
    log('play', `vid=${vid} 高清通道不可用（${e.message}），降级官网公开直链`);
  }
  sendJson(res, 200, { mode: 'web', quality: '360P', encrypted: false, url: `${SITE}/video/public/${vid}/360p.mp4` });
}

const STREAM_SEG = 2 * 1024 * 1024;

async function handleStream(req, res, u) {
  const vid = u.searchParams.get('vid') || '';
  const q = u.searchParams.get('q') || '';
  if (!/^\d+$/.test(vid)) return sendError(res, 400, 'bad vid');
  log('stream', `vid=${vid} q=${q || 'best'} range=${req.headers.range || 'open'}`);
  const attempt = async (fresh) => {
    if (fresh) {
      hdCache.delete(hdKey(vid, normalizeDef(q)));
      modelCache.delete(String(vid));
    }
    const stream = await resolveLiveStream(vid, normalizeDef(q));
    const prepared = stream.prepared; // resolveLiveStream 已完成头解析
    const total = prepared.total;
    const requested = hg.parseRangeHeader(req.headers.range || '', total);
    if (requested === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return { sent: true };
    }
    const [start, requestedEnd] = requested || [0, total - 1];
    const end = Math.min(requestedEnd, start + STREAM_SEG - 1, total - 1);
    const chunk = await hg.remoteRange(stream, start, end);
    const output = hg.decryptPartial(chunk.data, start, stream.key, prepared);
    return {
      sent: false,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': output.length,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=600', // 同一 vid|q 内容确定，允许浏览器缓存，切集/拖动秒开
        ETag: `"${vid}-${normalizeDef(q) || 'best'}-${total}"`,
      },
      output,
    };
  };
  try {
    let r;
    try {
      r = await attempt(false);
    } catch (e1) {
      r = await attempt(true); // 换一批 CDN 节点重试
    }
    if (r.sent) return;
    res.writeHead(206, r.headers);
    res.end(req.method === 'HEAD' ? undefined : r.output);
  } catch (e) {
    sendError(res, 502, `视频解析失败：${e.message}`);
  }
}

/* ---------------- 图片代理 ---------------- */

let imgFallbackBuf;
async function handleImg(res, u) {
  const target = u.searchParams.get('u') || '';
  if (!/^https:\/\//.test(target)) return sendError(res, 400, 'bad url');
  try {
    const r = await directAxios.get(target, {
      responseType: 'stream',
      timeout: 15000,
      headers: { 'User-Agent': BROWSER_UA, Referer: `${SITE}/`, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
      maxRedirects: 5,
    });
    res.writeHead(200, {
      'Content-Type': r.headers['content-type'] || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    });
    r.data.pipe(res);
  } catch {
    if (!imgFallbackBuf) imgFallbackBuf = fs.readFileSync(path.join(PUBLIC_DIR, 'img-fallback.svg'));
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(imgFallbackBuf);
  }
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(u.pathname);
  const page = Math.max(1, Number(u.searchParams.get('page') || 1));
  const t0 = Date.now();
  res.on('finish', () => {
    if (pathname.startsWith('/api/') || pathname === '/stream') {
      log('req', `${req.method} ${pathname}${u.search} → ${res.statusCode} (${Date.now() - t0}ms)`);
    }
  });
  try {
    if (pathname === '/api/health') return sendJson(res, 200, { service: 'hongguo-web', version: VERSION, ts: Date.now() });
    if (pathname === '/api/cache/clear') {
      let n = 0;
      try { n = fs.readdirSync(DC_DIR).filter((f) => f.endsWith('.json')).length; } catch {}
      try { fs.rmSync(DC_DIR, { recursive: true, force: true }); } catch {}
      textCache.clear();
      modelCache.clear();
      hg.pageCache.clear();
      hg.appSearchCache.clear();
      hg.videoInfoCache.clear();
      hg.streamCache.clear();
      homeCacheT = { time: 0, data: null };
      log('cache', `已清除全部缓存（${n} 条磁盘 + 内存）`);
      return sendJson(res, 200, { cleared: n });
    }
    if (pathname === '/api/home') {
      if (homeCacheT.data && Date.now() - homeCacheT.time < DATA_TTL) return sendJson(res, 200, homeCacheT.data);
      const shelves = [];
      for (const route of Object.keys(RANK_ROUTES)) {
        try {
          const r = await getRank(route, 1);
          if (r.items.length) {
            const entry = { key: route, title: RANK_ROUTES[route], items: r.items };
            lastGoodShelves.set(route, entry);
            shelves.push(entry);
          }
        } catch (e) {
          log('rank-fail', `${route} - ${e.message}`);
          const g = lastGoodShelves.get(route);
          if (g) shelves.push(g); // 本次限流失败，用最后一次成功的榜单兜底
        }
      }
      if (!shelves.length) {
        if (lastGoodHome) {
          log('home', '榜单全部失败，返回最后可用快照');
          return sendJson(res, 200, lastGoodHome);
        }
        return sendError(res, 502, '榜单数据全部拉取失败，请稍后重试');
      }
      homeCacheT = { time: Date.now(), data: { shelves } };
      lastGoodHome = homeCacheT.data;
      return sendJson(res, 200, homeCacheT.data);
    }
    if (pathname === '/api/rank') {
      const route = u.searchParams.get('route') || 'hot-drama';
      return sendJson(res, 200, { route, ...(await getRank(route, page)) });
    }
    if (pathname === '/api/categories') {
      return sendJson(res, 200, { types: CATEGORY_TYPES });
    }
    if (pathname === '/api/category') {
      const type = u.searchParams.get('type') || 'real-drama';
      const sub = u.searchParams.get('sub') || '';
      return sendJson(res, 200, await getCategory(type, sub, page));
    }
    if (pathname === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { items: [], page: 1, total: 0, via: 'none' });
      return sendJson(res, 200, await getSearch(q, page));
    }
    const seriesMatch = pathname.match(/^\/api\/series\/(\d+)$/);
    if (seriesMatch) return sendJson(res, 200, await getSeries(seriesMatch[1]));
    const web360 = pathname.match(/^\/web360\/(\d+)\.mp4$/);
    if (web360) {
      // 官网公开 360P 直链（播放器解码降级通道）
      res.writeHead(302, { Location: `${SITE}/video/public/${web360[1]}/360p.mp4` });
      return res.end();
    }
    if (pathname === '/api/play') return await handlePlay(res, u);
    if (pathname === '/stream') return await handleStream(req, res, u);
    if (pathname === '/img') return await handleImg(res, u);
    if (pathname.startsWith('/api/')) return sendError(res, 404, 'not found');
    return serveStatic(res, pathname);
  } catch (e) {
    log('err', `${pathname} - ${e.message}`);
    if (!res.headersSent) sendError(res, 502, e.message || 'internal error');
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  log('boot', '服务已启动');
  log('boot', `地址: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log('  数据: 官网 SSR + 番茄 App 接口（drpys 签名实现，GPL-3.0）');
  console.log('  提示: 非官方客户端，仅供个人本地使用；HOST=0.0.0.0 可开放局域网');
});
