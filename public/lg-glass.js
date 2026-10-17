/* ============================================================
   液态玻璃折射引擎（Chrome/Edge 全效果；Safari 自动回退普通毛玻璃）
   算法基于 nikdelvin/liquid-glass (MIT)：
   feImage 位移图（灰场 + 屏幕混合的 X/Y 边缘梯度）→ feDisplacementMap
   三通道（R/G/B）位移 + screen 混合 = 色差折射；blur/saturate 兜底
   ============================================================ */
(function () {
  'use strict';

  const PANELS = [
    '.topbar', '.feed-ctrl', '.player-top', '.player-bottom', '.drawer', '.pop-menu',
    '.suggest', '.toast', '.feed-tipbox', '.feed-error', '.searchbox input',
    '.cache-btn', '.feed-soundpill', '.feed-tip',
  ];

  let supported = null;
  function isSupported() {
    if (supported !== null) return supported;
    const t = document.createElement('div');
    t.style.cssText = 'backdrop-filter: url(#x)';
    supported = t.style.backdropFilter === 'url(#x)';
    return supported;
  }

  const px = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

  /* 位移图：灰场（无位移）+ 屏幕 blending 的 R/G 边缘梯度 + 内缩圆角矩形（边缘折射带） */
  function displacementMap(w, h, radius, depth) {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
`<svg height="${h}" width="${w}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <style>.mix{mix-blend-mode:screen}</style>
  <defs>
    <linearGradient id="Y" x1="0" x2="0" y1="${Math.ceil((radius / h) * 15)}%" y2="${Math.floor(100 - (radius / h) * 15)}%">
      <stop offset="0%" stop-color="#0F0"/><stop offset="100%" stop-color="#000"/>
    </linearGradient>
    <linearGradient id="X" x1="${Math.ceil((radius / w) * 15)}%" x2="${Math.floor(100 - (radius / w) * 15)}%" y1="0" y2="0">
      <stop offset="0%" stop-color="#F00"/><stop offset="100%" stop-color="#000"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" height="${h}" width="${w}" fill="#808080"/>
  <g filter="blur(2px)">
    <rect x="0" y="0" height="${h}" width="${w}" fill="#000080"/>
    <rect x="0" y="0" height="${h}" width="${w}" fill="url(#Y)" class="mix"/>
    <rect x="0" y="0" height="${h}" width="${w}" fill="url(#X)" class="mix"/>
    <rect x="${depth}" y="${depth}" height="${Math.max(1, h - 2 * depth)}" width="${Math.max(1, w - 2 * depth)}" fill="#808080" rx="${radius}" ry="${radius}" filter="blur(${depth}px)"/>
  </g>
</svg>`);
  }

  /* 三通道位移滤镜（含色差）：同一张位移图，R/G/B 不同强度，screen 混合 */
  function displacementFilter(w, h, radius, depth, strength, cab) {
    const map = displacementMap(w, h, radius, depth);
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
`<svg height="${h}" width="${w}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="d" color-interpolation-filters="sRGB" x="-20%" y="-20%" width="140%" height="140%">
      <feImage x="0" y="0" height="${h}" width="${w}" href="${map}" result="map"/>
      <feDisplacementMap transform-origin="center" in="SourceGraphic" in2="map" scale="${strength + cab * 2}" xChannelSelector="R" yChannelSelector="G"/>
      <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="dr"/>
      <feDisplacementMap transform-origin="center" in="SourceGraphic" in2="map" scale="${strength + cab}" xChannelSelector="R" yChannelSelector="G"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="dg"/>
      <feDisplacementMap transform-origin="center" in="SourceGraphic" in2="map" scale="${strength}" xChannelSelector="R" yChannelSelector="G"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="db"/>
      <feBlend in="dr" in2="dg" mode="screen"/>
      <feBlend in2="db" mode="screen"/>
    </filter>
  </defs>
</svg>`) + '#d';
  }

  const uriCache = new Map();
  function filterFor(el) {
    const r = el.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(r.width)), h = Math.max(1, Math.ceil(r.height));
    let radius = px(getComputedStyle(el).borderRadius);
    radius = Math.min(radius, h / 2, w / 2);
    const depth = radius > 24 ? 10 : 6;
    const strength = radius > 24 ? 72 : 56; // 大面板折射更强，小控件柔和
    const key = `${w}|${h}|${Math.round(radius)}|${depth}`;
    if (!uriCache.has(key)) uriCache.set(key, displacementFilter(w, h, Math.round(radius), depth, strength, 1.4));
    return uriCache.get(key);
  }

  function applyOne(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    el.style.backdropFilter = `url("${filterFor(el)}") blur(14px) saturate(1.65)`;
    el.style.webkitBackdropFilter = `url("${filterFor(el)}") blur(14px) saturate(1.65)`;
  }

  function apply(root) {
    if (!isSupported()) return;
    root = root || document;
    for (const sel of PANELS) {
      try { root.querySelectorAll(sel).forEach(applyOne); } catch {}
    }
  }

  /* 动态内容监控：新玻璃元素自动应用 */
  let mo = null;
  function observe() {
    if (mo) return;
    let t = null;
    mo = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => apply(document), 140);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => apply(document), 220);
  });

  document.addEventListener('DOMContentLoaded', () => { observe(); apply(document); });
  if (document.readyState !== 'loading') { observe(); apply(document); }
})();
