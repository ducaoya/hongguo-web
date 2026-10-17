/* 统一 API 客户端 + 数据缓存 */

export async function api(path) {
  const r = await fetch(path)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

export function img(u) {
  return u ? `/img?u=${encodeURIComponent(u)}` : '/img-fallback.svg'
}

export function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  const mm = String(m).padStart(2, '0'), ss = String(x).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

/* 剧目详情缓存（Promise 级：失败可重试） */
const seriesCache = new Map()
export function getSeries(id) {
  if (!seriesCache.has(id)) {
    const p = api(`/api/series/${id}`)
      .then((d) => { seriesCache.set(id, d); return d })
      .catch((e) => { seriesCache.delete(id); throw e })
    seriesCache.set(id, p)
  }
  return seriesCache.get(id)
}

const HOME_TTL = 5 * 60 * 1000
let homeMemo = null
export async function getHomeData() {
  if (homeMemo && Date.now() - homeMemo.t < HOME_TTL) return homeMemo.data
  const data = await api('/api/home')
  homeMemo = { t: Date.now(), data }
  return data
}
export function dropHomeData() { homeMemo = null }

/* 集数预加载（切集连贯性） */
const prewarm = new Map() // vid → { url, mode, quality, el }
export async function prefetchEpisode(vid, q) {
  if (!/^\d+$/.test(vid) || prewarm.has(vid)) return
  try {
    const play = await api(`/api/play?vid=${encodeURIComponent(vid)}&q=${encodeURIComponent(q || '')}`)
    const el = document.createElement('video')
    el.preload = 'auto'; el.muted = true; el.src = play.url; el.load()
    prewarm.set(vid, { el, url: play.url, mode: play.mode, quality: play.quality })
    if (prewarm.size > 6) {
      const k0 = prewarm.keys().next().value
      const e0 = prewarm.get(k0)
      e0.el.removeAttribute('src'); e0.el.load()
      prewarm.delete(k0)
    }
  } catch { /* 预热失败静默 */ }
}
export function takePrewarm(vid) {
  const p = prewarm.get(vid)
  if (p) prewarm.delete(vid)
  return p || null
}
export function prefetchUpcoming(series, fromIdx, q, count = 2) {
  for (let k = 1; k <= count; k += 1) {
    const ep = series.episodes?.[fromIdx + k]
    if (ep) prefetchEpisode(ep.vid, q)
  }
}
