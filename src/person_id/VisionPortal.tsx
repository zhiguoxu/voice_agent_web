/**
 * 把面板内部的 fixed 弹层（人物详情弹窗、事件 popover 等）portal 到
 * .vision-view 根元素下渲染。
 *
 * 原因：events/gallery 等面板容器带 backdrop-filter, 按 CSS 规范会成为
 * position:fixed 后代的包含块，弹层会被限制在面板内并被 overflow 裁剪。
 * portal 到根元素后 fixed 恢复视口定位，且仍在 .vision-view 作用域内，
 * vision.css 的选择器照常命中。
 */
import { createPortal } from "react-dom";
import { useVision } from "./context";

export function VisionPortal({ children }: { children: React.ReactNode }) {
  const { portalTarget } = useVision();
  if (!portalTarget) return children;
  return createPortal(children, portalTarget);
}
