<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, img } from './api'
import { toast, finishedTip, hideFinishedTip } from './store'
import PlayerOverlay from './views/PlayerView.vue'
import FeedOverlay from './views/FeedView.vue'

const route = useRoute()
const router = useRouter()

const isPlay = computed(() => route.path.startsWith('/play'))
const isFeed = computed(() => route.path === '/feed')

const navs = [
  { to: '/', label: '首页', key: 'home' },
  { to: '/feed', label: '推荐', key: 'feed' },
  { to: '/category/comic-drama', label: '分类', key: 'category' },
  { to: '/rank/hot-drama', label: '榜单', key: 'rank' },
  { to: '/history', label: '历史', key: 'history' },
]
const activeKey = computed(() => {
  const top = route.path.split('/').filter(Boolean)[0] || 'home'
  return ({ home: 'home', feed: 'feed', category: 'category', rank: 'rank', history: 'history' })[top] || ''
})

const q = ref('')
const suggest = ref({ show: false, items: [] })
let sugTimer = null, sugSeq = 0, sugAbort = null

async function onInput() {
  clearTimeout(sugTimer)
  const kw = q.value.trim()
  if (!kw) { suggest.value.show = false; return }
  sugTimer = setTimeout(async () => {
    const seq = ++sugSeq
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`)
      if (seq !== sugSeq) return
      if (!data.items.length) { suggest.value.show = false; return }
      suggest.value = { show: true, items: data.items.slice(0, 8) }
    } catch { suggest.value.show = false }
  }, 320)
}
function goSearch() {
  const kw = q.value.trim()
  if (kw) { suggest.value.show = false; q.value = ''; router.push(`/search/${encodeURIComponent(kw)}`) }
}
</script>

<template>
  <div class="grain" aria-hidden="true"></div>
  <div class="vignette" aria-hidden="true"></div>

  <header class="topbar">
    <router-link class="brand" to="/" title="红果短剧 · 深夜剧场">
      <span class="brand-mark"><i>红</i>果</span>
      <span class="brand-div" aria-hidden="true"></span>
      <span class="brand-sub">深夜剧场</span>
    </router-link>
    <nav class="nav" id="nav">
      <router-link v-for="n in navs" :key="n.key" :to="n.to" :data-nav="n.key">{{ n.label }}</router-link>
    </nav>
    <div class="searchbox">
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
      <input id="search-input" v-model="q" type="search" placeholder="搜索剧名…" autocomplete="off" spellcheck="false"
             @input="onInput" @keydown.enter="goSearch" @keydown.esc="suggest.show = false; $event.target.blur()">
      <div class="suggest" v-show="suggest.show">
        <div v-for="it in suggest.items" :key="it.id" class="suggest-item" @mousedown.prevent="q = ''; suggest.show = false; router.push(`/series/${it.id}`)">
          <img :src="img(it.cover)" alt="" onerror="this.src='/img-fallback.svg'">
          <span class="t">{{ it.title }}</span>
          <span class="r">{{ it.remarks }}</span>
        </div>
      </div>
    </div>
  </header>

  <main id="view" class="view" tabindex="-1">
    <router-view />
  </main>

  <FeedOverlay v-if="isFeed" />
  <PlayerOverlay v-if="isPlay" />

  <div id="toast" class="toast" :class="[toast.type, { out: toast.leaving }]" v-show="toast.show">{{ toast.msg }}</div>

  <transition name="tipfade">
    <div class="feed-tipbox" v-if="finishedTip.show">
      <div class="ft-msg">《{{ finishedTip.name }}》本季已播完</div>
      <div class="ft-actions">
        <button class="btn btn-red" @click="hideFinishedTip(); router.push(`/search/${encodeURIComponent(finishedTip.query)}`)">搜索同名剧集</button>
        <button class="icon-btn ft-close" title="关闭" @click="hideFinishedTip"><svg class="stroke" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
    </div>
  </transition>
</template>
