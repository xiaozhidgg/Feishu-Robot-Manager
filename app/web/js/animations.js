/* 动画预设：只改 <html data-anim>，具体时长与缓动在 CSS 里 */
window.ANIM_PRESETS = [
  { id: "smooth", name: "丝滑淡入", desc: "8px 上浮 + 柔和缓动，最耐看" },
  { id: "spring", name: "弹性回弹", desc: "带轻微 overshoot，手感活泼" },
  { id: "glass", name: "玻璃柔光", desc: "毛玻璃面板 + 背景柔光" },
  { id: "none", name: "极简零动画", desc: "全部瞬时切换，最跟手" },
];

window.applyAnimation = function applyAnimation(id, root) {
  const allowed = window.ANIM_PRESETS.map((p) => p.id);
  const target = allowed.includes(id) ? id : "smooth";
  (root || document.documentElement).dataset.anim = target;
  return target;
};
