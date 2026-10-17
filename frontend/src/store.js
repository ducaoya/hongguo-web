import { reactive, watch } from 'vue'

/* 观看进度（响应式 + 持久化） */
const progress = reactive(JSON.parse(localStorage.getItem('hg_progress') || '{}'))
function persistProgress() { try { localStorage.setItem('hg_progress', JSON.stringify(progress)) } catch {} }
export function useProgress() { return progress }
export function useSettings() { return settings }
export function saveProgress(sid, rec) {
  progress[sid] = { ...(progress[sid] || {}), ...rec, updatedAt: Date.now() }
  persistProgress()
}
export function removeProgress(sid) { delete progress[sid]; persistProgress() }
export function clearProgress() { Object.keys(progress).forEach((k) => delete progress[k]); persistProgress() }
export function getProgress(sid) { return progress[sid] || null }
export function progressEntries() {
  return Object.entries(progress)
    .map(([sid, rec]) => ({ sid, ...rec }))
    .filter((r) => r.name && r.vid)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
export function recordProgress(sid, name, cover, vid, epIndex, total, video) {
  if (!video || !video.duration || !isFinite(video.duration) || video.currentTime < 5) return
  saveProgress(sid, {
    name, cover, vid,
    index: Math.max(1, epIndex + 1),
    total: total || 0,
    time: video.currentTime, dur: video.duration,
  })
}

/* 设置（响应式 + 持久化） */
const settings = reactive(JSON.parse(localStorage.getItem('hg_settings') || '{}'))
function persistSettings() { try { localStorage.setItem('hg_settings', JSON.stringify(settings)) } catch {} }
export function setSetting(k, v) { settings[k] = v; persistSettings() }
export { settings }

/* 顶部提示（全局单例，双向动画） */
export const toast = reactive({ show: false, leaving: false, msg: '', type: '' })
let toastTimer = null, toastHideTimer = null
export function showToast(msg, type = '') {
  clearTimeout(toastTimer)
  clearTimeout(toastHideTimer)
  toast.msg = msg; toast.type = type; toast.leaving = false; toast.show = true
  toastTimer = setTimeout(() => {
    toast.leaving = true
    toastHideTimer = setTimeout(() => { toast.show = false; toast.leaving = false }, 300)
  }, 2600)
}

/* 本季播完：右下角提示（搜索同名剧集） */
export const finishedTip = reactive({ show: false, name: '', query: '' })
export function showFinishedTip(name) {
  const q = String(name || '').replace(/第\s*[0-9零一二两三四五六七八九十百千]+\s*季/g, '').replace(/[（(]\s*[）)]/g, '').replace(/[\s\-—·~：:，,]+$/g, '').trim() || String(name || '')
  finishedTip.show = true; finishedTip.name = name; finishedTip.query = q
  finishedTip.timer && clearTimeout(finishedTip.timer)
  finishedTip.timer = setTimeout(() => { finishedTip.show = false }, 25000)
}
export function hideFinishedTip() { finishedTip.show = false; clearTimeout(finishedTip.timer) }
