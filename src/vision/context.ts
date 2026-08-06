/**
 * 视觉仪表盘共享上下文：设备号、事件总线、WS 连接与全局 UI 能力
 * （toast / 图片灯箱 / 质量阈值），供各面板与弹窗组件消费。
 */
import { createContext, useContext } from "react";
import type { VisionBus } from "./bus";
import type { VisionSocket } from "./core/VisionSocket";
import type { QualityThresholds } from "./types";

export type ToastType = "success" | "error";

export interface VisionContextValue {
  cameraId: string;
  bus: VisionBus;
  socket: VisionSocket;
  /** 质量帧展示的高/低分界（来自服务端 flags，加载前用默认值） */
  qualityThresholds: QualityThresholds;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  /** 打开图片灯箱；bbox 非空时在预览图上叠加框线（原图像素坐标） */
  openLightbox: (src: string, bbox?: number[] | null, color?: string) => void;
  /**
   * 弹层 portal 目标（.vision-view 根元素）。
   * 面板容器带 backdrop-filter，会把 position:fixed 后代变成相对面板定位并被
   * overflow 裁剪；面板内的弹窗/popover 须经 VisionPortal 挂到根元素下。
   */
  portalTarget: HTMLElement | null;
}

export const VisionContext = createContext<VisionContextValue | null>(null);

export function useVision(): VisionContextValue {
  const ctx = useContext(VisionContext);
  if (!ctx) throw new Error("useVision must be used within VisionContext.Provider");
  return ctx;
}
