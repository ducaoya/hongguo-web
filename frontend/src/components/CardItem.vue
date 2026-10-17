<script setup>
import { useRouter } from 'vue-router'
import { getSeries, img } from '../api'
import { getProgress, showToast } from '../store'

const props = defineProps({
  item: { type: Object, required: true },
  index: { type: Number, default: 0 },
  rank: { type: Number, default: 0 },
  heat: { type: String, default: '' },
  resumeBar: { type: Number, default: null },
  resumeEp: { type: String, default: '' },
})
const router = useRouter()

async function goPlay() {
  try {
    const series = await getSeries(props.item.id)
    const rec = getProgress(props.item.id)
    const ep = (rec && series.episodes.find((x) => x.vid === rec.vid)) || series.episodes[0]
    router.push(`/play/${series.id}/${ep.vid}?q=${encodeURIComponent(series.qualities[0]?.key || '')}`)
  } catch (e) {
    showToast(e.message, 'err')
    router.push(`/series/${props.item.id}`)
  }
}
</script>

<template>
  <router-link class="card" :class="{ ranked: rank > 0 }" :to="`/series/${item.id}`" :data-sid="item.id"
               :style="{ animationDelay: Math.min(index * 45, 400) + 'ms' }" @click.prevent="goPlay">
    <div class="poster">
      <span v-if="rank" class="rank-no" :class="{ top: rank <= 3 }">{{ rank }}</span>
      <div v-if="item.statusTags?.length" class="tags">
        <span v-for="t in item.statusTags.slice(0, 1)" :key="t">{{ t }}</span>
      </div>
      <img :src="img(item.cover)" :alt="item.title" loading="lazy" onerror="this.src='/img-fallback.svg'">
      <span class="play-badge"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg></span>
      <button class="card-detail-btn" title="查看详情" @click.stop="$router.push(`/series/${item.id}`)">
        <svg class="stroke" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>
      </button>
      <div v-if="resumeBar != null" class="resume-bar"><i :style="{ width: Math.min(100, resumeBar) + '%' }"></i></div>
      <span v-if="resumeEp" class="resume-ep">看到 {{ resumeEp }}</span>
    </div>
    <div class="t">{{ item.title }}</div>
    <div class="r">
      <b v-if="item.score">{{ item.score }}</b><template v-if="item.score && (heat || item.remarks)"> · </template>
      {{ heat || item.remarks || '' }}
    </div>
  </router-link>
</template>
