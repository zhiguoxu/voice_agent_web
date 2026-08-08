/**
 * WebSocket 连接管理（从 person_id/frontend/js/websocket.js 移植）。
 *
 * - 二进制帧发送 (JPEG) / JSON 结果接收
 * - 服务端拉流模式下接收后端推送的 JPEG 预览帧
 * - 自动重连、背压控制（pendingFrame）
 * - FPS / 延迟统计与本地上传自适应帧率
 */
import type { FrameResult, VisionEvent } from "../types";
import type { FrameSink } from "./VideoCapture";

export class VisionSocket implements FrameSink {
  connected = false;
  pendingFrame = false;
  frameInterval = 100; // 初始 10 FPS
  private readonly minInterval = 33; // 最高 30 FPS
  private readonly maxInterval = 200; // 最低 5 FPS
  private readonly reconnectDelay = 2000;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  // 统计
  // - 服务端拉流观看: FPS 由 StreamViewer 上屏回调刷新 (见 refreshFpsFromViewer)
  // - 本地上传: 仍按 frame_result 到达间隔
  private lastResultTime = 0;
  private fpsHistory: number[] = [];
  private latencyHistory: number[] = [];

  /* ── 回调（由 VisionView 装配） ── */
  onResult: ((result: FrameResult) => void) | null = null;
  onEvent: ((event: VisionEvent) => void) | null = null;
  onConnected: (() => void) | null = null;
  onStatusChange: ((connected: boolean) => void) | null = null;
  /** 服务端拉流模式推送的 JPEG 帧 */
  onBinaryFrame: ((buf: ArrayBuffer) => void) | null = null;
  onIdentityConfirmed: ((name: string) => void) | null = null;
  /** 服务端错误反馈（confirm_error / consumer_active 之外的透传） */
  onServerError: ((code: string, message: string) => void) | null = null;
  /** 统计角标刷新（fps, latency ms） */
  onStats: ((fps: number, latency: number) => void) | null = null;
  /** 拉流观看模式下由 StreamViewer 提供真实上屏 FPS；返回 null 表示未在观看模式 */
  getViewerFPS: (() => number | null) | null = null;

  private buildUrl: () => string;

  constructor(buildUrl: () => string) {
    this.buildUrl = buildUrl;
  }

  /** 建立 WebSocket 连接 */
  connect(): void {
    this.disposed = false;
    this.createConnection();
  }

  private createConnection(): void {
    if (this.ws) this.ws.close();

    const url = this.buildUrl();
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      console.log("[WS] Connected to", url);
      this.connected = true;
      this.pendingFrame = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.onStatusChange?.(true);
      this.onConnected?.();
    };

    this.ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        this.handleTextMessage(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        // 服务端拉流模式: 后端推送的 JPEG 帧 → StreamViewer 渲染
        this.onBinaryFrame?.(event.data);
      }
    };

    this.ws.onclose = (event) => {
      console.log("[WS] Disconnected:", event.code, event.reason);
      this.connected = false;
      this.pendingFrame = false;
      this.onStatusChange?.(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error("[WS] Error:", error);
    };
  }

  private handleTextMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      if (msg.type === "frame_result") {
        this.pendingFrame = false; // 允许发送下一帧
        this.updateStats(msg);
        this.onResult?.(msg as FrameResult);
      } else if (msg.type === "event") {
        // 事件字段直接在 msg 顶层 (event_type, track_id, ...)
        this.onEvent?.(msg as VisionEvent);
      } else if (msg.type === "identity_confirmed") {
        this.onIdentityConfirmed?.(msg.name);
      } else if (msg.type === "error") {
        this.onServerError?.(msg.code, msg.message);
      }
    } catch (e) {
      console.error("[WS] Failed to parse message:", e);
    }
  }

  /** 发送视频帧 (JPEG 二进制) */
  sendFrame(blob: Blob): boolean {
    if (!this.connected || this.pendingFrame) return false;

    this.pendingFrame = true;
    void blob.arrayBuffer().then((buffer) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(buffer);
      } else {
        this.pendingFrame = false;
      }
    });
    return true;
  }

  /** 发送身份确认 */
  sendConfirmIdentity(trackId: number, personId: string | null, name: string): void {
    this.sendJSON({
      type: "confirm_identity",
      track_id: trackId,
      person_id: personId || null,
      name: name || "",
    });
  }

  private sendJSON(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** 更新延迟 / 本地采集自适应帧率; 服务端拉流时 FPS 由 StreamViewer 负责 */
  private updateStats(result: FrameResult): void {
    // 本地上传模式才用收包间隔计 FPS; 拉流观看时收包突发会虚高到上百
    const viewerFps = this.getViewerFPS?.();
    if (viewerFps == null) {
      const now = performance.now();
      if (this.lastResultTime > 0) {
        const dt = now - this.lastResultTime;
        if (dt >= 8 && dt < 5000) {
          this.fpsHistory.push(1000 / dt);
          if (this.fpsHistory.length > 30) this.fpsHistory.shift();
        }
      }
      this.lastResultTime = now;
    }

    if (result.processing_ms) {
      this.latencyHistory.push(result.processing_ms);
      if (this.latencyHistory.length > 30) this.latencyHistory.shift();

      // 自适应帧率 (仅本地上传模式用 frameInterval)
      if (result.processing_ms < 50) {
        this.frameInterval = Math.max(this.frameInterval - 5, this.minInterval);
      } else if (result.processing_ms > 100) {
        this.frameInterval = Math.min(this.frameInterval + 10, this.maxInterval);
      }
    }

    this.emitStats();
  }

  /** 服务端拉流观看: 按 canvas 实际绘制间隔刷新角标 */
  refreshFpsFromViewer(): void {
    this.emitStats();
  }

  get currentFPS(): number {
    const viewerFps = this.getViewerFPS?.();
    if (viewerFps != null) return viewerFps;
    if (this.fpsHistory.length === 0) return 0;
    return this.fpsHistory.reduce((a, b) => a + b, 0) / this.fpsHistory.length;
  }

  get currentLatency(): number {
    if (this.latencyHistory.length === 0) return 0;
    return this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;
  }

  private emitStats(): void {
    this.onStats?.(this.currentFPS, this.currentLatency);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    console.log(`[WS] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, this.reconnectDelay);
  }

  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // 卸载路径：先摘掉回调再关闭，避免触发无谓的重连/状态更新
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}
