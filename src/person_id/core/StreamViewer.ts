/**
 * 服务端拉流观看模式（从 person_id/frontend/js/stream-viewer.js 移植）。
 *
 * 服务端 StreamConsumer 后台拉流并识别后, 通过 WebSocket 推送:
 * - 二进制 JPEG 帧 → 本类解码并画到 canvas (取代 <video> 元素)
 * - frame_result JSON → 仍走 OverlayRenderer 画框
 *
 * 提供与 VideoCapture.getVideoRect() 相同结构的坐标基准。
 */
import type { VideoRect } from "../types";
import { FpsMeter } from "./fpsMeter";

export class StreamViewer {
  active = false;

  // 预览帧 (canvas 位图) 尺寸
  private frameW = 0;
  private frameH = 0;

  // 识别坐标基准 = 服务端处理帧尺寸 (随 frame_result 下发)。
  // 预览图可能为省带宽被缩小, 画框必须以处理帧尺寸为基准。
  private coordW = 0;
  private coordH = 0;

  // 解码背压: 解码中收到新帧则只保留最新的
  private decoding = false;
  private pendingBuf: ArrayBuffer | null = null;

  // 绘制帧率: 滑动时间窗吞吐 (不用帧间隔倒数平均 — pending 连画会虚高到 ~30)
  private readonly fpsMeter = new FpsMeter();

  /** 每成功画一帧回调（刷新 FPS 角标） */
  onDraw: (() => void) | null = null;
  /** 观看模式激活状态变化（进入/退出，驱动 React 同步 video/canvas 显隐） */
  onActiveChange: ((active: boolean) => void) | null = null;
  /** 因收到服务端帧而自动 start 时回调（同步拉流按钮/轮询状态） */
  onAutoStart: (() => void) | null = null;

  private getCanvas: () => HTMLCanvasElement | null;
  private getContainer: () => HTMLElement | null;

  constructor(getCanvas: () => HTMLCanvasElement | null,
              getContainer: () => HTMLElement | null) {
    this.getCanvas = getCanvas;
    this.getContainer = getContainer;
  }

  /** 进入观看模式 */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.onActiveChange?.(true);
    console.log("[StreamViewer] Started");
  }

  /** 退出观看模式 */
  stop(): void {
    if (!this.active && !this.pendingBuf) {
      this.onActiveChange?.(false);
      return;
    }
    this.active = false;
    this.pendingBuf = null;
    this.fpsMeter.reset();
    const canvas = this.getCanvas();
    if (canvas && canvas.width) {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }
    this.onActiveChange?.(false);
    console.log("[StreamViewer] Stopped");
  }

  /** 记录服务端处理帧尺寸 (由 VisionSocket 从 frame_result 中提取) */
  setFrameSize(w: number, h: number): void {
    if (w > 0 && h > 0) {
      this.coordW = w;
      this.coordH = h;
    }
  }

  get currentFPS(): number {
    return this.fpsMeter.value();
  }

  /** 收到服务端推送的二进制 JPEG 帧 */
  onFrame(buf: ArrayBuffer): void {
    if (!this.getCanvas()) return;
    // 只要服务端在推预览帧就进入观看模式 — 避免「别处开了拉流 / 重启恢复后」
    // 本页还没点按钮, active=false 把 JPEG 全丢了, 只剩 JSON 把角标刷到上百 FPS、画面卡死。
    if (!this.active) {
      this.start();
      this.onAutoStart?.();
    }
    if (this.decoding) {
      this.pendingBuf = buf;
      return;
    }
    void this.decodeAndDraw(buf);
  }

  private async decodeAndDraw(buf: ArrayBuffer): Promise<void> {
    this.decoding = true;
    try {
      const blob = new Blob([buf], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob);

      const canvas = this.getCanvas();
      if (!canvas) {
        bitmap.close();
        return;
      }
      this.frameW = bitmap.width;
      this.frameH = bitmap.height;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      bitmap.close();

      this.fpsMeter.record();
      this.onDraw?.();
    } catch (e) {
      console.error("[StreamViewer] Frame decode failed:", e);
    } finally {
      this.decoding = false;
      if (this.pendingBuf) {
        const next = this.pendingBuf;
        this.pendingBuf = null;
        // 必须 await, 否则 finally 里同步间隙会与新的 onFrame 并发解码
        await this.decodeAndDraw(next);
      }
    }
  }

  /** 坐标基准 (与 VideoCapture.getVideoRect 同构, 供 OverlayRenderer 使用) */
  getVideoRect(): VideoRect | null {
    const container = this.getContainer();
    if (!container || !this.frameW || !this.frameH) return null;

    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    // canvas 使用 object-fit: contain, 计算实际显示区域
    const scale = Math.min(containerW / this.frameW, containerH / this.frameH);
    const displayW = this.frameW * scale;
    const displayH = this.frameH * scale;

    return {
      offsetX: (containerW - displayW) / 2,
      offsetY: (containerH - displayH) / 2,
      displayW, displayH, scale,
      // 坐标基准: 优先用服务端处理帧尺寸 (预览图可能缩小过)
      videoW: this.coordW || this.frameW,
      videoH: this.coordH || this.frameH,
    };
  }
}
