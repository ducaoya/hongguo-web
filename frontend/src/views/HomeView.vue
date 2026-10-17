<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, dropHomeData, getHomeData, getSeries, img } from '../api'
import { showToast, useProgress, useSettings, saveProgress, getProgress } from '../store'
import CardItem from '../components/CardItem.vue'
import Shelf from '../components/Shelf.vue'
import EmptyState from '../components/EmptyState.vue'

const PLAY_SVG = 'M8 5.5v13l11-6.5z'
const router = useRouter()
const progress = useProgress()
const settings = useSettings()

const loading = ref(true)
const shelves = ref([])
const loadError = ref('')

const top10 = computed(() => (shelves.value[0]?.items || []).slice(0, 10))

const continueItems = computed(() =>
  progressEntriesFiltered().slice(0, 12)
)
function progressEntriesFiltered() {
  return Object.entries(progress)
    .map(([sid, rec]) => ({ sid, ...rec }))
    .filter((r) => r.name && r.vid)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/* 3D 轮播 */
const hi = ref(0)
let heroTimer = null
function layout() { /* 由响应式 class/style 驱动 */ }
function go(i) {
  const n = top10.value.length
  if (!n) return
  hi.value = ((i % n) + n) % n
}
const cardStyle = (i) => {
  const n = top10.value.length
  let off = ((i - hi.value) % n + n) % n
  if (off > n / 2) off -= n
  const abs = Math.abs(off)
  return {
    opacity: abs <= 2 ? String(1 - abs * 0.3) : '0',
    zIndex: String(20 - abs),
    pointerEvents: off === 0 ? 'auto' : 'none',
    transform: `translate(-50%, -50%) translateX(${off * 64}%) rotateY(${off === 0 ? 0 : off < 0 ? 30 : -30}deg) scale(${off === 0 ? 1 : Math.max(0.7, 1 - abs * 0.12)})`,
  }
}
function heroAuto() {
  clearInterval(heroTimer)
  heroTimer = setInterval(() => go(hi.value + 1), 5000)
}
function onWheel(e) {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 24) return
  go(hi.value + (e.deltaX > 0 ? 1 : -1))
}
let dragStart = null
function onDown(e) { dragStart = { x: e.clientX, y: e.clientY } }
function onUp(e) {
  if (!dragStart) return
  const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y
  dragStart = null
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) go(hi.value + (dx < 0 ? 1 : -1))
}

async function playSeries(id) {
  try {
    const series = await getSeries(id)
    const rec = getProgress(id)
    const ep = (rec && series.episodes.find((x) => x.vid === rec.vid)) || series.episodes[0]
    router.push(`/play/${series.id}/${ep.vid}?q=${encodeURIComponent(series.qualities[0]?.key || '')}`)
  } catch (e) { showToast(e.message, 'err') }
}

async function clearCache() {
  try {
    const r = await api('/api/cache/clear')
    dropHomeData()
    showToast(`已清除 ${r.cleared} 条缓存，正在刷新…`)
    loading.value = true; shelves.value = []
    const d = await getHomeData()
    shelves.value = d.shelves
    loading.value = false
  } catch (e) { showToast(e.message, 'err') }
}

onMounted(async () => {
  heroAuto()
  try {
    const d = await getHomeData()
    shelves.value = d.shelves
  } catch (e) { loadError.value = e.message }
  loading.value = false
})
onUnmounted(() => clearInterval(heroTimer))
</script>

<template>
  <div>
    <!-- 3D 轮播 -->
    <div v-if="!loading && top10.length" class="hero3d" id="hero" @mouseenter="clearInterval(heroTimer)" @mouseleave="heroAuto" @wheel="onWheel" @pointerdown="onDown" @pointerup="onUp">
      <div class="c3d-stage">
        <div v-for="(it, i) in top10" :key="it.id" class="c3d-card" :class="{ center: i === hi }"
             :style="cardStyle(i)" @click="i !== hi && go(i)">
          <img :src="img(it.cover)" :alt="it.title" onerror="this.src='/img-fallback.svg'">
          <div class="c3d-cap">
            <div class="c3d-kicker">
              <span class="flame">热榜 No.{{ i + 1 }}</span>
              <span class="score" v-if="it.score">{{ it.score }}</span>
            </div>
            <div class="c3d-title">{{ it.title }}</div>
            <div class="c3d-chips">
              <span class="chip hot" v-if="it.heat">{{ it.heat }}</span>
              <span class="chip" v-for="t in (it.tags || []).slice(0, 2)" :key="t">{{ t }}</span>
            </div>
            <div class="c3d-actions">
              <button class="btn btn-red hero-play-btn" @click.stop="playSeries(it.id)">
                <svg viewBox="0 0 24 24"><path :d="PLAY_SVG"/></svg> 观看
              </button>
              <router-link class="btn btn-ghost" :to="`/series/${it.id}`">详情</router-link>
            </div>
          </div>
        </div>
      </div>
      <button class="hero-arrow" data-dir="prev" title="上一部" @click="go(hi - 1)">
        <svg class="stroke" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>
      </button>
      <button class="hero-arrow" data-dir="next" title="下一部" @click="go(hi + 1)">
        <svg class="stroke" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
      </button>
      <div class="hero-dots">
        <button v-for="(it, i) in top10" :key="i" class="hero-dot" :class="{ on: i === hi }" @click="go(i)"></button>
      </div>
    </div>
    <div v-if="loading" class="hero3d"><div class="c3d-stage"><div class="c3d-card sk" style="width:clamp(176px,20vh,224px)"></div></div></div>

    <div class="page">
      <div v-if="loadError" class="error-box">
        <div class="msg">内容加载失败：{{ loadError }}</div>
        <button class="btn btn-red" @click="location.reload()">重新加载</button>
      </div>

      <Shelf v-if="continueItems.length" title="继续观看">
        <CardItem v-for="(r, i) in continueItems" :key="r.sid" :item="{ id: r.sid, title: r.name, cover: r.cover }"
                  :index="i" :resume-bar="r.dur ? (r.time / r.dur) * 100 : 0" :resume-ep="`第${r.index}集`"
                  @play="playSeries(r.sid)" />
      </Shelf>

      <Shelf v-for="s in shelves" :key="s.key" :title="s.title" :more-to="`/rank/${s.key}`">
        <CardItem v-for="(it, i) in s.items" :key="it.id" :item="it" :index="i"
                  :rank="s.key === shelves[0]?.key ? i + 1 : 0" :heat="s.key === shelves[0]?.key ? it.remarks : ''"
                  @play="playSeries(it.id)" />
      </Shelf>
    </div>

    <button class="cache-btn" :disabled="false" @click="clearCache">清除服务器缓存</button>
  </div>
</template>
