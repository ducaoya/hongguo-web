<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, getSeries, img } from '../api'
import { getProgress, showToast, useSettings } from '../store'
import CardItem from '../components/CardItem.vue'
import EmptyState from '../components/EmptyState.vue'
import Shelf from '../components/Shelf.vue'

const route = useRoute()
const router = useRouter()
const settings = useSettings()

const id = computed(() => route.params.id)
const s = ref(null)
const loadError = ref('')

const rec = computed(() => getProgress(id.value))
const currentIndex = computed(() => {
  const r = rec.value
  if (!r) return 0
  return s.value ? s.value.episodes.findIndex((e) => e.vid === r.vid) + 1 : 0
})
const firstTarget = computed(() => {
  const r = rec.value
  if (r) { const e = s.value.episodes.find((x) => x.vid === r.vid); if (e) return e }
  return s.value.episodes[0]
})
const resumeT = computed(() => (rec.value && rec.value.vid === firstTarget.value?.vid && rec.value.time > 10) ? Math.floor(rec.value.time) : 0)

function go(vid, t = 0) {
  router.push({ path: `/play/${id.value}/${vid}`, query: { q: s.value.qualities[0]?.key || '', t } })
}
</script>

<template>
  <div class="page">
    <div v-if="loadError" class="error-box"><div class="msg">{{ loadError }}</div><button class="btn btn-red" @click="router.go(0)">重试</button></div>
  </div>
</template>
