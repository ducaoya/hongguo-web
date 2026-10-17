<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { showToast } from '../store'
import CardItem from '../components/CardItem.vue'
import EmptyState from '../components/EmptyState.vue'

const route = useRoute()

const TYPES = [['comic-drama', '漫剧'], ['real-drama', '真人剧'], ['ai-drama', 'AI 剧']]
const type = computed(() => route.params.type || 'comic-drama')
const sub = computed(() => (/^[a-z-]+$/.test(route.params.sub || '') ? route.params.sub : ''))

const CAT_TTL = 15 * 60 * 1000
const catKey = (t, sb) => `hg_cat:${t}:${sb || 'all'}`

const items = ref([])
const totalPages = ref(1)
const total = ref(0)
const selectors = ref(null)
const loadingMore = ref(false)
const finished = ref(false)
const scrollRegion = ref(null)
const sentinel = ref(null)
let curPage = 0
let io = null

const chips = computed(() => [{ id: '', name: '全部' }, ...(selectors.value?.[0]?.items || [])])

function lsGet(key, ttl) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); if (v && Date.now() - v.t < ttl) return v.data } catch {}
  return null
}
function lsSet(key, data) { try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), data })) } catch {} }

async function loadMore() {
  if (loadingMore.value || finished.value) return
  loadingMore.value = true
  try {
    const nextPage = curPage + 1
    const data = await api(`/api/category?type=${encodeURIComponent(type.value)}&sub=${encodeURIComponent(sub.value)}&page=${nextPage}`)
    if (!selectors.value && data.selectors?.length) selectors.value = data.selectors
    if (!data.items.length) { finished.value = true; return }
    items.value = items.value.concat(data.items)
    curPage = nextPage
    totalPages.value = data.totalPages || totalPages.value
    total.value = data.total || total.value
    lsSet(catKey(type.value, sub.value), { items: items.value, page: curPage, totalPages: totalPages.value, total: total.value, selectors: selectors.value })
    if (nextPage >= (data.totalPages || 1)) finished.value = true
  } catch (e) {
    showToast(e.message, 'err')
    finished.value = true
  } finally { loadingMore.value = false }
}

watch([type, sub], () => {
  const cached = lsGet(catKey(type.value, sub.value), CAT_TTL)
  items.value = cached?.items || []
  curPage = cached?.page || 0
  totalPages.value = cached?.totalPages || 1
  total.value = cached?.total || 0
  selectors.value = cached?.selectors || null
  finished.value = false
  if (!cached) { items.value = []; curPage = 0; loadMore() }
}, { immediate: true })

onMounted(() => {
  io = new IntersectionObserver((es) => {
    if (es[0].isIntersecting) loadMore()
  }, { root: scrollRegion.value, rootMargin: '400px' })
  io.observe(sentinel.value)
})
onUnmounted(() => io?.disconnect())
</script>

<template>
  <div class="fixed-page">
    <div class="fixed-head">
      <div class="type-tabs">
        <router-link v-for="[slug, name] in TYPES" :key="slug" class="type-tab"
                     :class="{ on: slug === type }" :to="`/category/${slug}`">{{ name }}</router-link>
      </div>
      <div class="filter-row">
        <span class="filter-label">题材</span>
        <div class="filter-scroll">
          <router-link class="fchip" :class="{ on: c.id === sub }" v-for="c in chips" :key="c.id"
                       :to="`/category/${type}/${c.id}/1`">{{ c.name }}</router-link>
        </div>
      </div>
    </div>
    <div class="scroll-region" ref="scrollRegion">
      <div class="grid">
        <CardItem v-for="(it, i) in items" :key="it.id" :item="it" :index="i" />
      </div>
      <div class="load-sentinel" ref="sentinel">
        <div class="load-line" v-if="!finished || items.length">{{ finished ? '已经到底了' : (loadingMore ? '加载中…' : '加载中…') }}</div>
      </div>
    </div>
  </div>
</template>
