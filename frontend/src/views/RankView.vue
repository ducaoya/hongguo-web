<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, img } from '../api'
import { showToast } from '../store'
import EmptyState from '../components/EmptyState.vue'

const route = useRoute()
const RANK_ROUTES = {
  'hot-drama': '红果热播榜',
  'hot-real-drama': '真人剧热播榜',
  'hot-comic-drama': '漫剧热播榜',
  'hot-ai-drama': 'AI 剧热播榜',
}
const routeKey = computed(() => route.params.route || 'hot-drama')

const states = ref({})
const st_ = computed(() => {
  const k = routeKey.value
  if (!states.value[k]) states.value[k] = { items: [], page: 0, totalPages: 1 }
  return states.value[k]
})
const busy = ref(false)
const finished = ref(false)

const scrollRegion = ref(null)
const sentinel = ref(null)
let io = null

async function loadMore() {
  if (busy.value || finished.value) return false
  busy.value = true
  const s = st_.value
  try {
    const data = await api(`/api/rank?route=${encodeURIComponent(routeKey.value)}&page=${s.page + 1}`)
    if (!data.items.length) return false
    s.items = s.items.concat(data.items)
    s.page = data.page
    s.totalPages = data.totalPages || s.totalPages
    if (s.page >= (s.totalPages || 1)) { finished.value = true; return false }
    return true
  } catch (e) { showToast(e.message, 'err'); return false } finally { busy.value = false }
}

watch(routeKey, async () => {
  finished.value = false
  if (!st_.value.items.length) await loadMore()
})

onMounted(async () => {
  io = new IntersectionObserver(async (es) => {
    if (!es[0].isIntersecting) return
    const more = await loadMore()
    if (!more) finished.value = true
  }, { root: scrollRegion.value, rootMargin: '400px' })
  io.observe(sentinel.value)
  if (!st_.value.items.length) await loadMore()
})
onUnmounted(() => io?.disconnect())
</script>

<template>
  <div class="fixed-page">
    <div class="fixed-head">
      <div class="sec-head" style="margin:0"><h2>{{ RANK_ROUTES[routeKey] || '榜单' }}</h2></div>
    </div>
    <div class="scroll-region" ref="scrollRegion">
      <div class="rank-list">
        <router-link v-for="(it, i) in st_.items" :key="it.id" class="rank-row" :to="`/series/${it.id}`"
                     :style="{ animationDelay: Math.min(i * 26, 320) + 'ms' }">
          <span class="no" :class="{ top: i < 3 }">{{ i + 1 }}</span>
          <img :src="img(it.cover)" alt="" loading="lazy" onerror="this.src='/img-fallback.svg'">
          <div class="m">
            <div class="t">{{ it.title }}</div>
            <div class="d">
              <span class="heat" v-if="it.heat">{{ it.heat }}</span>
              <span v-if="it.remarks">{{ it.remarks }}</span>
              <span v-for="t in (it.tags || []).slice(0, 3)" :key="t">{{ t }}</span>
            </div>
          </div>
          <span class="score" v-if="it.score">{{ it.score.replace('评分', '') }}</span>
        </router-link>
        <EmptyState v-if="!st_.items.length && finished" title="暂无数据" desc="榜单暂时拉取失败，请稍后重试" />
      </div>
      <div class="load-sentinel" ref="sentinel">
        <div class="load-line">{{ finished ? '已经到底了' : (busy ? '加载中…' : '加载中…') }}</div>
      </div>
    </div>
  </div>
</template>
