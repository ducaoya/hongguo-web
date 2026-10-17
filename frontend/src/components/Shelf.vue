<script setup>
import { onMounted, onUnmounted, ref } from 'vue'

const props = defineProps({
  title: { type: String, required: true },
  moreTo: { type: String, default: '' },
})
const rail = ref(null)
const fade = ref(null)
const atEnd = ref(false)

function refresh() {
  const el = rail.value
  if (!el) return
  atEnd.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 || el.scrollWidth <= el.clientWidth + 4
}
onMounted(() => { refresh(); rail.value?.addEventListener('scroll', refresh, { passive: true }) })
onUnmounted(() => rail.value?.removeEventListener('scroll', refresh))
</script>

<template>
  <section class="sec">
    <div class="sec-head">
      <h2>{{ title }}</h2>
      <router-link v-if="moreTo" class="more" :to="moreTo">查看全部 →</router-link>
    </div>
    <div class="rail-wrap">
      <div ref="rail" class="rail"><slot /></div>
      <div class="rail-fade" :class="{ off: atEnd }"></div>
    </div>
  </section>
</template>
