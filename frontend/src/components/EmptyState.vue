<script setup>
defineProps({
  title: { type: String, required: true },
  desc: { type: String, default: '' },
})
</script>

<template>
  <div class="empty2">
    <svg class="empty2-art" viewBox="0 0 220 132" aria-hidden="true">
      <defs>
        <linearGradient id="emptyBeam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgba(217,164,65,.32)"/>
          <stop offset="1" stop-color="rgba(217,164,65,0)"/>
        </linearGradient>
      </defs>
      <path d="M96 26 L44 100 L176 100 L124 26 Z" fill="url(#emptyBeam)"/>
      <rect x="92" y="8" width="36" height="20" rx="5" fill="rgba(255,255,255,.08)" stroke="rgba(255,255,255,.32)"/>
      <rect x="98" y="13" width="10" height="10" rx="2" fill="rgba(255,255,255,.14)"/>
      <rect x="112" y="13" width="10" height="10" rx="2" fill="rgba(255,255,255,.14)"/>
      <circle cx="110" cy="32" r="4" fill="rgba(255,222,150,.92)"/>
      <rect x="52" y="92" width="116" height="34" rx="6" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.28)"/>
      <path d="M104 100 L118 109 L104 118 Z" fill="rgba(255,255,255,.8)"/>
      <circle cx="82" cy="52" r="1.6" fill="rgba(255,255,255,.35)"/>
      <circle cx="130" cy="44" r="1.2" fill="rgba(255,255,255,.3)"/>
      <circle cx="150" cy="66" r="1.8" fill="rgba(255,255,255,.24)"/>
      <circle cx="70" cy="74" r="1.1" fill="rgba(255,255,255,.2)"/>
      <circle cx="112" cy="60" r="1.3" fill="rgba(255,255,255,.26)"/>
    </svg>
    <div class="empty2-title">{{ title }}</div>
    <div class="empty2-desc">{{ desc }}</div>
    <div class="empty2-actions" v-if="$slots.default"><slot /></div>
  </div>
</template>
