<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, img } from '../api'
import { showToast } from '../store'
import CardItem from '../components/CardItem.vue'
import EmptyState from '../components/EmptyState.vue'

const route = useRoute()
const q = computed(() => decodeURIComponent(route.params.q || ''))

const items = ref([])
const total = ref(0)
const via = ref('app')
const loading = ref(true)
const loadingMore = ref(false)
const moreHidden = ref(false)
let page = 1

watch(q, () => { page = 1; items.value = []; moreHidden.value = false }, { immediate: false })

async function load(pageNum) {
  return api(`/api/search?q=${encodeURIComponent(q.value)}&page=${pageNum}`)
}

watch(q, async () => {
  loading.value = true
  try {
    const data = await load(q.value, 1)
    if (q.value !== (route.params.q || '')) return
    items.value = data.items
    total.value = data.total
    via.value = data.via
    moreHidden.value = data.via === 'site'
  } catch (e) { showToast(e.message, 'err'); items.value = [] } finally { loading.value = false }
}, { immediate: true })

async function more() {
  if (loadingMore.value) return
  loadingMore.value = true
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q.value)}&page=${page + 1}`)
    if (!data.items.length) { moreHidden.value = true; showToast('没有更多了'); return }
    const have = new Set(items.value.map((i) => i.id))
    const fresh = data.items.filter((i) => !have.has(i.id))
    items.value = items.value.concat(fresh)
    page += 1
    if (!fresh.length || (data.via === 'site' && data.total && page * 10 >= data.total)) moreHidden.value = true
  } catch (e) { showToast(e.message, 'err') } finally { loadingMore.value = false }
}
</script>

<template>
  <div class="page">
    <div class="sec-head">
      <h2>“{{ q }}” 的搜索结果</h2>
      <a class="more" v-if="via === 'site'">官网搜索每次最多提供 10 部</a>
      <a class="more" v-if="total">共 {{ total }} 部</a>
    </div>
    <div class="grid" v-if="items.length">
      <CardItem v-for="(it, i) in items" :key="it.id" :item="it" :index="i" />
    </div>
    <div class="empty2" v-else-if="!loading">
      <div class="empty2-title">没有找到相关剧集</div>
      <div class="empty2-desc">换个关键词试试，或者去分类里逛逛</div>
      <div class="empty2-actions"><router-link class="btn btn-red" to="/category/comic-drama">去分类</router-link></div>
    </div>
    <div class="pager" v-if="items.length && !moreHidden">
      <button class="btn btn-ghost" @click="more" :disabled="loadingMore">{{ loadingMore ? '加载中…' : '加载更多' }}</button>
    </div>
  </div>
</template>
