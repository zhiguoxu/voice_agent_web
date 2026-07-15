/**
 * 全局 tooltip：给任意元素加 data-tip 属性即可。
 *
 * 原生 title 有 ~1s 的浏览器内置延迟且样式不可配，这里统一替代：
 * 悬浮 0.6s 后在元素上方显示（放不下时翻到下方），移开立即消失。
 * 样式见 App.css 的 .app-tooltip。
 */

const SHOW_DELAY_MS = 600;

let tipEl: HTMLDivElement | null = null;
let anchor: Element | null = null;
let timer: number | null = null;

function ensureTipEl(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "app-tooltip";
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function show(target: Element): void {
  const text = target.getAttribute("data-tip");
  if (!text) return;
  const tip = ensureTipEl();
  tip.textContent = text;
  tip.style.display = "block";

  // 先渲染再量尺寸，才能做边界翻转/夹取
  const rect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const margin = 4;

  // 水平：与元素左缘对齐，夹在视口内
  const left = Math.max(
    margin,
    Math.min(rect.left, window.innerWidth - tipRect.width - margin)
  );
  // 垂直：默认在元素上方，放不下翻到下方
  let top = rect.top - tipRect.height - margin;
  if (top < margin) top = rect.bottom + margin;

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hide(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  anchor = null;
  if (tipEl) tipEl.style.display = "none";
}

/** 应用启动时调用一次，挂载全局监听。 */
export function initTooltip(): void {
  document.addEventListener("mouseover", (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
    if (target === anchor) return;
    hide();
    if (target) {
      anchor = target;
      timer = window.setTimeout(() => show(target), SHOW_DELAY_MS);
    }
  });
  // 鼠标移出窗口时收不到 mouseover，单独兜底
  document.addEventListener("mouseout", (e: MouseEvent) => {
    if (e.relatedTarget === null) hide();
  });
  // 点击/滚动时立即消失，避免 tip 跟着错位
  document.addEventListener("mousedown", hide, true);
  document.addEventListener("scroll", hide, true);
}
