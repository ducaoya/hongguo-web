<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, fmtTime, getSeries, img, prefetchUpcoming, takePrewarm } from '../api'
import { getProgress, recordProgress, saveProgress, settings, showToast, showFinishedTip } from '../store'
import EmptyState from '../components/EmptyState.vue'

const route = useRoute()
const router = useRouter()

const sid = computed(() => route.params.sid)
const vid = computed(() => route.params.vid)
const qParam = computed(() => String(route.query.q || '').toLowerCase())
const resumeQuery = computed(() => Number(route.query.t || 0))

const s = ref(null)
const loadError = ref('')
const loading = ref(true)
const play = ref(null) // { mode, quality, url }
const epIndex = ref(0)
const resumeAt = ref(0)

const video = ref(null)
const layer = ref(null)
const muted = ref(false)
const volume = ref(1)
const bigOn = ref(false)
const playing = ref(false)
const buffering = ref(false)
const speed = ref(1)
const fitOn = computed(() => settings.fit === 'cover')
const cur = ref(0), dur = ref(0), playPct = ref(0), bufPct = ref(0)
const seekDrag = ref(false)
const trackEl = ref(null)
const errMsg = ref('')
const qualityPop = ref(false)
const qualityLabel = computed(() => {
  const q = qualities.value.find((x) => x.key === qParam.value)
  return q ? q.label : '360P'
})
const idle = ref(false)
const drawerOpen = ref(false)
const popOpen = ref('')
const wheelLock = ref(0)
const curChunk = ref(0)

const EP_CHUNK = 50
const chunkCount = computed(() => (s.value ? Math.ceil(s.value.episodes.length / EP_CHUNK) : 1))
const chunkEps = computed(() => {
  const start = curChunk.value * EP_CHUNK
  return s.value ? s.value.episodes.slice(start, start + EP_CHUNK) : []
})

const ep = computed(() => s.value?.episodes[epIndex.value] || null)
const qualities = computed(() => s.value?.qualities || [])
const rec0 = computed(() => getProgress(sid.value))

/* 音量 */
const lastVol = ref(1)
const volIc = computed(() => muted.value
  ? 'M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6'
  : 'M4 9v6h4l5 4V5L8 9zM16 9c1.5 1.5 1.5 4.5 0 6')
function setVolume(v) {
  volume.value = Math.min(1, Math.max(0, v))
  muted.value = volume.value === 0
  if (video.value) { video.value.volume = volume.value; video.value.muted = muted.value }
}
function volSlider(e) {
  volume.value = Number(e.target.value) / 100
  muted.value = volume.value === 0
  if (video.value) { video.value.volume = volume.value; video.value.muted = muted.value }
}
function toggleMute() { setVolume(muted.value ? (lastVol.value || 1) : 0) }

/* 播放/暂停 */
const togglePlay = () => (video.value?.paused ? video.value.play().catch(() => {}) : video.value.pause())

/* 原地切集 */
async function switchEpisode(nextVid) {
  if (nextVid === vid.value || !s.value) return
  const ep2 = s.value.episodes.find((e) => e.vid === nextVid)
  if (!ep2) return
  saveNow()
  const wasPlaying = playing.value
  loading.value = true; errMsg.value = ''
  let p = takePrewarm(nextVid)
  if (!p) {
    try { p = await api(`/api/play?vid=${encodeURIComponent(nextVid)}&q=${encodeURIComponent(qParam.value || '')}`) } catch { p = null }
  }
  if (!p) { loading.value = false; errMsg.value = '切换失败，请重试'; return }
  epIndex.value = ep2.index - 1
  resumeAt.value = 0
  play.value = p
  loading.value = false
  history.replaceState(history.state, '', `#/play/${sid.value}/${nextVid}?q=${encodeURIComponent(qParam.value || '')}`)
}

/* 原地切清晰度 */
async function switchQuality(newQ) {
  if (!newQ || newQ === qParam.value) return
  const at = video.value?.currentTime || 0
  const wasPlaying = playing.value
  loading.value = true
  let p = null
  try { p = await api(`/api/play?vid=${encodeURIComponent(vid.value)}&q=${encodeURIComponent(newQ)}`) } catch { p = null }
  if (!p) { showToast('切换失败，请重试', 'err'); loading.value = false; return }
  play.value = p
  loading.value = false
  history.replaceState(history.state, '', `#/play/${sid.value}/${vid.value}?q=${encodeURIComponent(newQ)}`)
  if (video.value) {
    video.value.src = p.url
    video.value.load()
    video.value.addEventListener('loadedmetadata', () => { video.value.currentTime = Math.min(at, video.value.duration || at); if (wasPlaying) video.value.play().catch(() => {}) }, { once: true })
  }
}

const nextEp = () => {
  const nx = s.value.episodes[epIndex.value + 1]
  if (!nx) { showToast('已经是最后一集了'); return false }
  switchEpisode(nx.vid)
  return true
}
const prevEp = () => {
  const pv = s.value.episodes[epIndex.value - 1]
  if (!pv) { showToast('已经是第一集了'); return false }
  switchEpisode(pv.vid)
  return true
}

function seekUI() {
  const v = video.value
  if (!v || !v.duration || !isFinite(v.duration)) return
  const pct = Math.min(100, (v.currentTime / v.duration) * 100)
  playPct.value = pct
  cur.value = fmtTime(v.currentTime)
  dur.value = fmtTime(v.duration)
  if (v.buffered.length) bufPct.value = Math.min(100, (v.buffered.end(v.buffered.length - 1) / v.duration) * 100)
}
function seekFromEvent(ev) {
  const v = video.value
  if (!v || !v.duration || !isFinite(v.duration) || !trackEl.value) return
  const rect = trackEl.value.getBoundingClientRect()
  v.currentTime = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) * v.duration
}

/* 事件（视频） */
function onMeta() {
  applyFit()
  if (resumeAt.value > 0 && resumeAt.value < video.value.duration - 15) {
    video.value.currentTime = resumeAt.value
    showToast(`已从 ${fmtTime(resumeAt.value)} 继续播放`)
  }
  seekUI()
  prefetchUpcoming(s.value, epIndex.value, qParam.value || s.value.qualities[0]?.key || '', 2)
  video.value.play().catch(() => { bigOn.value = true })
}
function onTimeUpdate() {
  seekUI()
  recordProgress(sid.value, s.value.name, s.value.cover, vid.value, epIndex.value, s.value.episodes.length, video.value)
}
function onEnded() {
  if (!s.value.episodes[epIndex.value + 1]) { showFinishedTip(s.value.name); return }
  if (settings.autoNext !== false) nextEp()
}
function onVideoError() {
  if (!video.value?.src) return
  const code = video.value.error ? video.value.error.code : '?'
  const names = { 1: '加载被中断', 2: '网络错误', 3: '解码失败', 4: '格式不支持' }
  // 清晰度切换/换集后 10s 内的解码失败：自动重载该流（从头），规避 seek+HEVC 管线问题
  if (recentSwitch.value && !switchRetried.value) {
    switchRetried.value = true
    showToast('解码失败，已自动从头重试', 'err')
    const u = video.value.src
    video.value.src = u; video.value.load()
    video.value.play().catch(() => {})
    return
  }
  showToast(`视频加载失败（${names[code] || '未知错误 ' + code}）`, 'err')
}
const switchRetried = ref(false)
const recentSwitch = ref(0)
watch([vid, qParam], () => { switchRetried.value = false })

/* 视频适配（竖屏高度撑满左右留黑） */
function applyFit() {
  const v = video.value, l = layer.value
  if (!v || !l) return
  const portrait = v.videoHeight > v.videoWidth
  const cover = settings.fit === 'cover' && !portrait
  const W = l.clientWidth || window.innerWidth
  const H = l.clientHeight || window.innerHeight
  if (cover) { v.style.width = W + 'px'; v.style.height = H + 'px'; v.style.objectFit = 'cover' }
  else {
    const sc = Math.min(W / (v.videoWidth || 16), H / (v.videoHeight || 9))
    v.style.width = Math.round((v.videoWidth || 16) * sc) + 'px'
    v.style.height = Math.round((v.videoHeight || 9) * sc) + 'px'
    v.style.objectFit = 'fill'
  }
}
function onResize() { applyFit() }

/* 键盘/手势/滚轮 */
function onKey(ev) {
  if (ev.target.tagName === 'INPUT') return
  if (drawerOpen.value && ['ArrowLeft', 'ArrowRight', ' '].includes(ev.key)) return
  switch (ev.key) {
    case ' ': ev.preventDefault(); togglePlay(); break
    case 'ArrowLeft': video.value.currentTime = Math.max(0, video.value.currentTime - 5); wake(); break
    case 'ArrowRight': video.value.currentTime = Math.min(video.value.duration || 1e9, video.value.currentTime + 5); wake(); break
    case 'ArrowUp': ev.preventDefault(); prevEp(); break
    case 'ArrowDown': ev.preventDefault(); nextEp(); break
    case 'm': case 'M': toggleMute(); break
    case 'n': case 'N': nextEp(); break
    case 'p': case 'P': prevEp(); break
    case 'f': case 'F': toggleFs(); break
    case 'Escape':
      if (drawerOpen.value) drawerOpen.value = false
      else if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
      else history.back()
      break
  }
}
function onWheel(ev) {
  if (seekDrag.value || drawerOpen.value || popOpen.value) return
  const now = Date.now()
  if (now - wheelLock.value < 900 || Math.abs(ev.deltaY) < 18) return
  wheelLock.value = now
  ev.deltaY > 0 ? nextEp() : prevEp()
}
let touchStart = null
function onTouchStart(ev) { if (ev.touches.length === 1) touchStart = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, t: Date.now() } }
function onTouchEnd(ev) {
  if (!touchStart) return
  const dx = ev.changedTouches[0].clientX - touchStart.x
  const dy = ev.changedTouches[0].clientY - touchStart.y
  const dt = Date.now() - touchStart.t
  touchStart = null
  if (dt > 900) return
  if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx) * 1.3) { dy < 0 ? prevEp() : nextEp(); return }
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.3) {
    const v = video.value
    if (v) { v.currentTime = Math.max(0, Math.min(v.duration || 1e9, v.currentTime + (dx < 0 ? -10 : 10))); showToast(dx < 0 ? '快退 10s' : '快进 10s') }
  }
}

/* 抽屉（50集分组） */
function renderChunk(c) { curChunk.value = c }

/* 生命周期 */
onMounted(async () => {
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  window.addEventListener('beforeunload', saveNow)
  saveTimer.value = setInterval(saveNow, 3000)

  const t0 = resumeQuery.value || (rec0.value && rec0.value.vid === vid.value && rec0.value.time > 10 ? rec0.value.time : 0)
  resumeAt.value = t0
  let p = takePrewarm(vid.value)
  if (!p) {
    try { p = await api(`/api/play?vid=${encodeURIComponent(vid.value)}&q=${encodeURIComponent(qParam.value || '')}`) } catch { p = null }
  }
  if (!p) { loading.value = false; errMsg.value = '播放解析失败，请稍后重试'; return }
  play.value = p
  loading.value = false
})
onUnmounted(() => {
  saveNow()
  clearInterval(saveTimer.value)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('beforeunload', saveNow)
  document.body.style.overflow = ''
  clearTimeout(idleTimer.value)
})
</script>

<template>
  <div class="player-layer" ref="layer">
    <div v-if="loading" class="sk" style="position:absolute;inset:0;border-radius:0"></div>
    <div v-else-if="loadError" class="player-error"><div class="pe-msg">{{ loadError }}</div><button class="btn btn-red" @click="router.go(0)">重试</button></div>
    <template v-else>
      <div class="player-video-wrap" @wheel="onWheel" @touchstart="onTouchStart" @touchend="onTouchEnd" @pointermove="wake">
        <video ref="pv" playsinline preload="auto" :src="play.url"
               @loadedmetadata="onMeta" @timeupdate="onTimeUpdate" @ended="onEnded" @error="onVideoError"
               @waiting="buffering = true" @playing="buffering = false"
               @play="playing = true; bigOn = false" @pause="playing = false; bigOn = true"
               @click="togglePlay"></video>
      </div>
      <div class="player-ui" :class="{ idle }">
        <div class="player-top">
          <button class="icon-btn" title="返回 (Esc)" @click="router.back()"><svg class="stroke" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
          <div class="player-title">
            <div class="t">{{ s.name }}</div>
            <div class="s">第 {{ ep.index }} 集 · <b>{{ play.quality }}</b>{{ play.mode === 'web' ? ' · 官网直连' : '' }}</div>
          </div>
          <div style="flex:1"></div>
          <button class="icon-btn" title="选集" @click="drawerOpen = !drawerOpen"><svg class="stroke" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg></button>
        </div>
        <div class="player-center">
          <button class="icon-btn big-play" v-show="bigOn" @click="togglePlay"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg></button>
        </div>
        <div class="player-bottom">
          <div class="seek">
            <span class="tm">{{ cur }}</span>
            <div class="seek-track" ref="trackEl" @pointerdown="onTrackDown" @pointermove="onTrackMove" @pointerup="seekDrag = false">
              <div class="rail-bg"></div><div class="rail-buf" :style="{ width: bufPct + '%' }"></div>
              <div class="rail-play" :style="{ width: playPct + '%' }"></div>
              <div class="knob" :style="{ left: playPct + '%' }"></div>
            </div>
            <span class="tm">{{ dur }}</span>
          </div>
          <div class="ctrl-row">
            <button class="icon-btn" title="播放/暂停 (空格)" @click="togglePlay"><svg class="stroke" viewBox="0 0 24 24"><path :d="playing ? 'M8 5v14M16 5v14' : 'M8 5.5v13l11-6.5z'"/></svg></button>
            <button class="icon-btn" title="上一集 (↑/P/滚轮上)" @click="prevEp"><svg class="stroke" viewBox="0 0 24 24"><path d="M18 5v14L8 12zM6 5v14"/></svg></button>
            <button class="icon-btn" title="下一集 (↓/N/滚轮下)" @click="nextEp"><svg class="stroke" viewBox="0 0 24 24"><path d="M6 5v14l10-7zM18 5v14"/></svg></button>
            <button class="icon-btn" title="静音 (M)" @click="toggleMute"><svg class="stroke" viewBox="0 0 24 24"><path :d="volIc"/></svg></button>
            <input class="vol-range" type="range" min="0" max="100" :value="Math.round((muted ? 0 : volume) * 100)" @input="setVolume(Number($event.target.value) / 100)" :style="{ '--fill': Math.round((muted ? 0 : volume) * 100) + '%' }" title="音量">
            <div class="spacer"></div>
            <button class="ctrl-label" @click="cycleSpeed">{{ speed }}x</button>
            <button class="ctrl-label q" @click="qualityPop = qualityPop === 'quality' ? '' : 'quality'">{{ qualityLabel }}</button>
            <button class="ctrl-label" @click="settings.fit = settings.fit === 'cover' ? 'contain' : 'cover'">{{ settings.fit === 'cover' ? '铺满' : '适应' }}</button>
            <button class="ctrl-label" :class="{ off: settings.autoNext === false }" @click="settings.autoNext = settings.autoNext === false">连播</button>
            <button class="icon-btn" title="全屏 (F)" @click="layer.requestFullscreen?.().catch(() => {})"><svg class="stroke" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
          </div>
        </div>
        <aside class="drawer" :class="{ open: drawerOpen }">
          <div class="drawer-head">
            <img class="drawer-cover" :src="img(s.cover)" alt="" onerror="this.src='/img-fallback.svg'">
            <div class="drawer-headinfo"><h3>{{ s.name }}</h3><div class="d-sub">{{ s.remarks }}</div></div>
            <button class="icon-btn" @click="drawerOpen = false"><svg class="stroke" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          </div>
          <div class="drawer-intro">{{ s.intro }}</div>
          <div class="chunk-tabs" v-if="chunkCount > 1">
            <button v-for="c in chunkCount" :key="c" class="chunk-tab" :class="{ on: c - 1 === curChunk }" @click="curChunk = c - 1">{{ c * EP_CHUNK - EP_CHUNK + 1 }}-{{ Math.min(c * EP_CHUNK, s.episodes.length) }}集</button>
          </div>
          <div class="drawer-body"><div class="ep-grid">
            <button v-for="e in chunkEps" :key="e.vid" class="ep-btn" :class="{ current: e.vid === vid }" @click="switchEpisode(e.vid)">{{ e.index }}</button>
          </div></div>
        </aside>
        <div class="pop-menu" v-if="popOpen === 'quality'" style="right:20px;bottom:120px;left:auto">
          <button v-for="x in qualities" :key="x.key" :class="{ on: x.key === qParam }" @click="qualityPop = false; switchQuality(x.key)">{{ x.label }}</button>
        </div>
      </div>
      <div class="buffer-spin" v-if="buffering"></div>
    </template>
  </div>
</template>
