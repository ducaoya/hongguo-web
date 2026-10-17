<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fmtTime, img } from '../api'
import { clearProgress, removeProgress, useProgress } from '../store'
import EmptyState from '../components/EmptyState.vue'

const route = useRoute()
const router = useRouter()
const progress = useProgress()

const entries = computed(() =>
  Object.entries(progress)
    .map(([sid, rec]) => ({ sid, ...rec }))
    .filter((r) => r.name && r.vid)
    .sort((a, b) => b.updatedAt - a.updatedAt)
)

function del(sid) {
  removeProgress(sid)
  showToast('已删除该记录')
}
function clearAll() {
  clearProgress()
  showToast('已清空全部观看记录')
}
</script>

<template>
  <div class="fixed-page">
    <div class="fixed-head">
      <div class="sec-head" style="margin:0">
        <h2>观看历史</h2>
        <a class="more">共 {{ entries.length }} 部</a>
        <button v-if="entries.length" class="btn btn-ghost" style="margin-left:auto;height:32px;padding:0 12px;font-size:12px" @click="clearAll">清空全部</button>
      </div>
    </div>
    <div class="scroll-region">
      <div class="grid" v-if="entries.length">
        <router-link v-for="(r, i) in entries" :key="r.sid" class="card" :to="`/play/${r.sid}/${r.vid}?t=${Math.floor(r.time || 0)}`"
                     :style="{ animationDelay: Math.min(i * 35, 350) + 'ms' }">
          <div class="poster">
            <img :src="img(r.cover)" :alt="r.name" loading="lazy" onerror="this.src='/img-fallback.svg'">
            <span class="play-badge"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg></span>
            <div class="resume-bar"><i :style="{ width: (r.dur ? Math.min(100, (r.time / r.dur) * 100) : 0) + '%' }"></i></div>
            <span class="resume-ep">第{{ r.index }}集 · {{ fmtTime(r.time) }}</span>
            <button class="card-detail-btn his-del" title="删除该记录" @click.prevent.stop="del(r.sid)">
              <svg class="stroke" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
          <div class="t">{{ r.name }}</div>
          <div class="r">{{ r.total ? `共 ${r.total} 集` : '' }}{{ r.total && r.index ? ' · ' : '' }}第 {{ r.index }} 集</div>
        </router-link>
      </div>
      <EmptyState v-else title="剧场还未开演" desc="看完一集后，这里会记下你的观影足迹">
        <router-link class="btn btn-red" to="/feed">去推荐刷剧 →</router-link>
        <router-link class="btn btn-ghost" to="/">返回首页</router-link>
      </EmptyState>
    </div>
  </div>
</template>
