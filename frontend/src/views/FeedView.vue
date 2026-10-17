<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, fmtTime, getHomeData, getSeries, img, prefetchEpisode, prefetchUpcoming, takePrewarm } from '../api'
import { getProgress, recordProgress, settings, showToast } from '../store'

const router = useRouter()

const feed = reactive({
  list: [], idx: -1, epIdx: 0, vid: '',
  series: null, muted: false, tagMaps: {}, loadToken: 0,
})
const currentPlay = reactive({ url: '', mode: '', quality: '' })
const loading = ref(false)
const errMsg = ref('')
const bigOn = ref(true)
const videoEl = ref(null)
const scroller = ref(null)
const started = ref(false)

const TYPE_BY_SHELF = {
  'hot-drama': 'real-drama', 'hot-real-drama': 'real-drama',
  'hot-comic-drama': 'comic-drama', 'hot-ai-drama': 'ai-drama',
}

let saveTimer = null
let token = 0

const cur = computed(() => feed.list[feed.idx] || null)

async function playEpisode(i, epIdx, { startAt = 0, isRetry = false } = {}) {
  const myToken = ++token
  feed.idx = i; feed.epIdx = epIdx; feed.vid = ''
  loading.value = true; errMsg.value = ''; bigOn.value = true
  const d = feed.list[i]
  const s = await getSeries(d.id).catch(() => null)
  if (token !== myToken) return
  if (!s) { loading.value = false; errMsg.value = '剧集数据加载失败'; return }
  const ep = s.episodes[epIdx]
  if (!ep) return feedGoto(i + 1)
  feed.series = s; feed.vid = ep.vid
  feed.states?.set?.(i, { s, epIdx })

  let play = takePrewarm(ep.vid)
  if (!play) {
    try { play = await api(`/api/play?vid=${encodeURIComponent(ep.vid)}&q=${encodeURIComponent(s.qualities[0]?.key || '')}`) } catch { play = null }
  }
  if (token !== myToken) return
  if (!play) { loading.value = false; errMsg.value = '播放解析失败，请重试'; return }
  currentPlay.url = play.url; currentPlay.mode = play.mode; currentPlay.quality = play.quality
}

function onMeta() {
  const v = videoEl.value
  if (!v) return
  loading.value = false
  applyFit()
  v.play().catch(() => {
    v.muted = true; feed.muted = true
    v.play().catch(() => {})
    showToast('已静音自动播放，点按喇叭开启声音')
  })
}
function onTimeUpdate() {
  const v = videoEl.value
  if (!v || !feed.series || !feed.list[feed.idx]) return
  recordProgress(feed.list[feed.idx].id, feed.series.name, feed.list[feed.idx].cover, feed.vid, feed.epIdx, feed.series.episodes.length, v)
  const pct = v.duration ? Math.min(100, (v.currentTime / v.duration) * 100) : 0
  if (fcPlay.value) fcPlay.value.style.width = pct + '%'
  if (fcKnob.value) fcKnob.value.style.left = pct + '%'
  if (fcCur.value) fcCur.value.textContent = fmtTime(v.currentTime)
  if (fcDur.value && v.duration) fcDur.value.textContent = fmtTime(v.duration)
}
function onEnded() {
  const v = videoEl.value
  if (v && feed.series && feed.list[feed.idx]) {
    recordProgress(feed.list[feed.idx].id, feed.series.name, feed.list[feed.idx].cover, feed.vid, feed.epIdx, feed.series.episodes.length, v)
  }
  if (feed.series?.episodes[feed.epIdx + 1]) playEpisode(feed.idx, feed.epIdx + 1)
  else { showFinishedTip(feed.series?.name || ''); feedGoto(feed.idx + 1) }
}
function onVideoError() {
  loading.value = false
  errMsg.value = '本集加载失败，请重试'
}
function togglePlay() {
  const v = videoEl.value
  if (!v) return
  v.paused ? v.play().catch(() => {}) : v.pause()
}
function retry() {
  errMsg.value = ''
  playEpisode(feed.idx, feed.epIdx, { isRetry: true })
}

/* 显示定位：滚动切换剧集 */
function showAt(i, { startAt = 0 } = {}) {
  if (i < 0 || i >= feed.list.length) return
  if (i === feed.idx && videoEl.value) return
  const d = feed.list[i]
  const rec = getProgress(d.id)
  let resumeVid = null, resumeTime = 0
  if (rec && rec.vid) { resumeVid = rec.vid; resumeTime = rec.time > 10 ? rec.time : 0 }
  feed.idx = i
  getSeries(d.id).then((s) => {
    if (feed.idx !== i) return
    const epIdx = resumeVid ? Math.max(0, s.episodes.findIndex((x) => x.vid === resumeVid)) : 0
    playEpisode(i, epIdx, { startAt: resumeTime })
  }).catch(() => { feed.idx = -1; errMsg.value = '剧集数据加载失败' })
}
function feedGoto(i) {
  if (i < 0 || i >= feed.list.length) { showToast('已经全部刷完啦'); return }
  const sc = scroller.value
  if (sc) sc.scrollTo({ top: i * sc.clientHeight, behavior: 'smooth' })
}
let scrollTimer = null
function onScroll() {
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => {
    const sc = scroller.value
    if (!sc) return
    const i = Math.round(sc.scrollTop / sc.clientHeight)
    if (i !== feed.idx || !videoEl.value) showAt(i)
  }, 160)
}

/* 控件 */
function switchEp(delta) {
  const s = feed.series
  if (!s) return
  const nx = s.episodes[feed.epIdx + delta]
  if (!nx) { showToast(delta > 0 ? '已经是最后一集了' : '已经是第一集了'); return }
  playEpisode(feed.idx, feed.epIdx + delta)
}
function toggleMute() {
  feed.muted = !feed.muted
  if (videoEl.value) videoEl.value.muted = feed.muted
}
function goPlayPage() {
  if (!feed.vid || !feed.series || !feed.list[feed.idx]) { showToast('还在加载当前剧集'); return }
  const v = videoEl.value
  const t = v && isFinite(v.currentTime) ? Math.floor(v.currentTime) : 0
  recordProgress(feed.list[feed.idx].id, feed.series.name, feed.list[feed.idx].cover, feed.vid, feed.epIdx, feed.series.episodes.length, v)
  router.push(`/play/${feed.list[feed.idx].id}/${feed.vid}?q=${encodeURIComponent(feed.series.qualities[0]?.key || '')}&t=${t}`)
}
function tagJump(tag, i) {
  const d = feed.list[i] || feed.list[feed.idx]
  const type = d?.type || 'real-drama'
  const map = feed.tagMaps[type] || {}
  let slug = map[tag] || ''
  if (!slug) {
    const hit = Object.keys(map).find((n) => n.includes(tag) || tag.includes(n))
    if (hit) slug = map[hit]
  }
  if (slug) router.push(`/category/${type}/${slug}/1`)
  else { showToast(`「${tag}」暂无对应题材分类，已转搜索`); router.push(`/search/${encodeURIComponent(tag)}`) }
}

/* 视频适配（竖屏高度撑满左右留黑） */
function applyFit() {
  const v = videoEl.value
  if (!v) return
  const vw = v.videoWidth, vh = v.videoHeight
  if (!vw || !vh) return
  const portrait = vh > vw
  const cover = settings.fit === 'cover' && !portrait
  const area = v.closest('.feed-video-slot')
  const W = (area && area.clientWidth) || window.innerWidth
  const H = (area && area.clientHeight) || window.innerHeight
  if (cover) { v.style.width = W + 'px'; v.style.height = H + 'px'; v.style.objectFit = 'cover' }
  else {
    const sc = Math.min(W / vw, H / vh)
    v.style.width = Math.round(vw * sc) + 'px'
    v.style.height = Math.round(vh * sc) + 'px'
    v.style.objectFit = 'fill'
  }
}
const onResize = () => applyFit()

function onKey(ev) {
  if (ev.target.tagName === 'INPUT') return
  switch (ev.key) {
    case 'ArrowUp': ev.preventDefault(); feedGoto(feed.idx - 1); break
    case 'ArrowDown': ev.preventDefault(); feedGoto(feed.idx + 1); break
    case 'ArrowLeft': ev.preventDefault(); switchEp(-1); break
    case 'ArrowRight': ev.preventDefault(); switchEp(1); break
    case ' ': ev.preventDefault(); togglePlay(); break
    case 'm': case 'M': toggleMute(); break
    case 'Escape': history.back(); break
  }
}

function saveNow() {
  const v = videoEl.value
  if (v && feed.series && feed.vid && feed.list[feed.idx]) {
    recordProgress(feed.list[feed.idx].id, feed.series.name, feed.list[feed.idx].cover, feed.vid, feed.epIdx, feed.series.episodes.length, v)
  }
}

onMounted(async () => {
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  window.addEventListener('beforeunload', saveNow)
  saveTimer = setInterval(saveNow, 3000)
  try {
    const { shelves } = await getHomeData()
    const seen = new Set()
    for (const sh of shelves) for (const it of sh.items) {
      if (!seen.has(it.id)) { seen.add(it.id); feed.list.push({ ...it, type: TYPE_BY_SHELF[sh.key] || 'real-drama' }) }
    }
    feed.list = feed.list.slice(0, 40)
  } catch (e) { showToast(e.message, 'err'); return }
  if (!feed.list.length) return
  // 预取题材映射
  new Set(feed.list.map((d) => d.type)).forEach((type) => {
    if (feed.tagMaps[type] || feed.tagMaps[type + ':loading']) return
    feed.tagMaps[type + ':loading'] = true
    api(`/api/category?type=${encodeURIComponent(type)}&page=1`).then((d) => {
      const m = {}
      for (const row of d.selectors || []) for (const it of row.items || []) m[it.name] = it.id
      feed.tagMaps[type] = m
    }).catch(() => { feed.tagMaps[type] = {} })
  })
  showAt(0)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('beforeunload', saveNow)
  clearInterval(saveTimer)
  clearTimeout(scrollTimer)
  document.body.style.overflow = ''
  feed.loadToken += 1
  if (feed.fitFeedOld) window.removeEventListener('resize', feed.fitFeedOld)
})
</script>

<template>
  <div class="player-layer feed-mode">
    <div class="feed" ref="scroller" @scroll="onScroll">
      <div class="feed-tip">↑ ↓ 切换剧集 · ← → 切换集数 · 滚轮滑动 · Esc 退出</div>
      <section v-for="(d, i) in feed.list" :key="d.id" class="feed-item">
        <div class="feed-bg"><img :src="img(d.cover)" alt="" loading="lazy" onerror="this.style.display='none'"></div>
        <div class="feed-video-slot" :id="`fv-${i}`">
          <template v-if="i === feed.idx">
            <video v-if="currentPlay.url" ref="videoEl" :src="currentPlay.url" playsinline preload="auto"
                   :muted="feed.muted" @loadedmetadata="onMeta" @timeupdate="onTimeUpdate" @click="togglePlay"
                   @ended="onEnded" @error="onVideoError" @play="bigOn = false" @pause="bigOn = true"></video>
            <div v-if="loading" class="feed-loading on"><div class="feed-spinner"></div></div>
            <button v-if="bigOn && !loading && !errMsg" class="feed-bigbtn" @click="togglePlay">
              <svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>
            </button>
            <button v-if="feed.muted && started" class="feed-soundpill" @click="feed.muted = false; if (videoEl) videoEl.muted = false">
              声音已关闭 · 点击开启
            </button>
            <div v-if="errMsg" class="feed-error">
              <div class="fe-msg">{{ errMsg }}</div>
              <button class="btn btn-red" @click="retry">重试</button>
            </div>
          </template>
        </div>
        <div class="feed-shade"></div>
        <div class="feed-overlay">
          <div class="feed-meta">
            <h3>{{ d.title }}</h3>
            <div class="feed-chips">
              <button class="chip chip-link" v-for="t in (d.tags || []).slice(0, 3)" :key="t" @click="tagJump(t, i)">{{ t }}</button>
              <span class="chip hot" v-if="d.remarks">{{ d.remarks }}</span>
            </div>
            <div class="feed-ep" v-if="i === feed.idx && feed.series">
              第 {{ feed.epIdx + 1 }} 集 · 共 {{ feed.series.episodes.length }} 集
            </div>
          </div>
          <div class="feed-side">
            <button class="icon-btn" data-act="detail" title="查看详情" @click="router.push(`/series/${d.id}`)">
              <svg class="stroke" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>
            </button>
          </div>
        </div>
      </section>
    </div>
    <div class="feed-ctrl">
      <div class="seek">
        <span class="tm" id="fc-cur">0:00</span>
        <div class="seek-track" id="fc-track">
          <div class="rail-bg"></div>
          <div class="rail-buf" id="fc-buf"></div>
          <div class="rail-play" ref="fcPlay"></div>
          <div class="knob" ref="fcKnob" style="left:0"></div>
        </div>
        <span class="tm" id="fc-dur">0:00</span>
      </div>
      <div class="ctrl-row">
        <button class="icon-btn" id="fc-toggle" title="播放/暂停 (空格)" @click="togglePlay">
          <svg class="stroke" viewBox="0 0 24 24"><path :d="bigOn ? 'M8 5.5v13l11-6.5z' : 'M8 5v14M16 5v14'"/></svg>
        </button>
        <button class="icon-btn" id="fc-prev" title="上一集 (←)" @click="switchEp(-1)"><svg class="stroke" viewBox="0 0 24 24"><path d="M18 5v14L8 12zM6 5v14"/></svg></button>
        <button class="icon-btn" id="fc-next" title="下一集 (→)" @click="switchEp(1)"><svg class="stroke" viewBox="0 0 24 24"><path d="M6 5v14l10-7zM18 5v14"/></svg></button>
        <div style="flex:1"></div>
        <button class="icon-btn" id="fc-mute" title="静音 (M)" @click="toggleMute">
          <svg class="stroke" viewBox="0 0 24 24"><path :d="feed.muted ? 'M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6' : 'M4 9v6h4l5 4V5L8 9zM16 9c1.5 1.5 1.5 4.5 0 6'"/></svg>
        </button>
        <button class="btn btn-red feed-open-btn" @click="goPlayPage">进入播放页 →</button>
      </div>
    </div>
  </div>
</template>
