/**
 * 摄像头采集管理（从 person_id/frontend/js/video-capture.js 移植）。
 *
 * - 枚举可用本地摄像头
 * - 支持网络流 (FLV via flv.js / MJPEG; HLS 仅 Safari 原生支持)
 * - 开始/停止采集
 * - 定时抓帧并通过 WebSocket 发送（事件驱动 + 预编码，最大化吞吐）
 */
// flv.js 体量大且仅网络 FLV 流场景用到, startFlvStream 内动态 import 按需加载
import type flvjs from "flv.js";
import type { VideoRect } from "../types";

/** 帧发送端接口（由 VisionSocket 实现） */
export interface FrameSink {
  readonly connected: boolean;
  readonly pendingFrame: boolean;
  readonly frameInterval: number;
  sendFrame(blob: Blob): boolean;
}

export type SourceType = "local" | "network";

export class VideoCapture {
  capturing = false;
  sourceType: SourceType = "local";
  streamUrl = "";
  devicesEnumerated = false;

  private stream: MediaStream | null = null;
  private pendingStream: MediaStream | null = null;
  private captureCanvas: HTMLCanvasElement;
  private captureCtx: CanvasRenderingContext2D | null;
  private readonly maxCaptureWidth = 640; // 限制最大发送宽度
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private adjustTimer: ReturnType<typeof setInterval> | null = null; // 动态帧率调整
  private pendingBlob: Blob | null = null; // 预编码好的下一帧
  private flvPlayer: flvjs.Player | null = null;

  /** 采集状态变化回调（同步 React 按钮与占位提示） */
  onCaptureChange: ((capturing: boolean) => void) | null = null;

  private getVideoEl: () => HTMLVideoElement | null;
  private getContainer: () => HTMLElement | null;
  private sink: FrameSink;

  constructor(
    getVideoEl: () => HTMLVideoElement | null,
    getContainer: () => HTMLElement | null,
    sink: FrameSink,
  ) {
    this.getVideoEl = getVideoEl;
    this.getContainer = getContainer;
    this.sink = sink;
    this.captureCanvas = document.createElement("canvas");
    this.captureCanvas.width = 640;
    this.captureCanvas.height = 480;
    this.captureCtx = this.captureCanvas.getContext("2d");
  }

  setSourceType(type: SourceType): void {
    this.sourceType = type;
  }

  setStreamUrl(url: string): void {
    this.streamUrl = url;
  }

  /** 枚举可用本地摄像头设备 (保留 stream 供 start 复用，避免二次弹窗) */
  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    try {
      this.pendingStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === "videoinput");
    } catch (e) {
      console.error("[Camera] Failed to enumerate devices:", e);
      return [];
    }
  }

  /** 开始采集 (根据 sourceType 决定本地或网络) */
  async start(deviceId: string | null = null): Promise<void> {
    if (this.capturing) return;
    if (this.sourceType === "network") {
      await this.startNetworkStream();
    } else {
      await this.startLocalCamera(deviceId);
    }
  }

  private async startLocalCamera(deviceId: string | null): Promise<void> {
    const videoEl = this.getVideoEl();
    if (!videoEl) return;
    try {
      // 复用 enumerateDevices 保留的 stream (避免二次权限弹窗)
      if (this.pendingStream && !deviceId) {
        this.stream = this.pendingStream;
        this.pendingStream = null;
      } else {
        if (this.pendingStream) {
          this.pendingStream.getTracks().forEach((t) => t.stop());
          this.pendingStream = null;
        }
        const constraints: MediaStreamConstraints = {
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          },
          audio: false,
        };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      }

      videoEl.srcObject = this.stream;
      await videoEl.play();

      this.capturing = true;
      this.onCaptureChange?.(true);
      this.startFrameLoop();
      console.log("[Camera] Local camera started");
    } catch (e: unknown) {
      console.error("[Camera] Failed to start local camera:", e);
      alert("Camera access failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  private async startNetworkStream(): Promise<void> {
    const url = this.streamUrl.trim();
    if (!url) {
      alert("请输入网络摄像头的直播地址");
      return;
    }

    const streamType = this.detectStreamType(url);
    console.log(`[Camera] Starting network stream: type=${streamType}, url=${url}`);

    try {
      if (streamType === "flv") {
        await this.startFlvStream(url);
      } else {
        // HLS (Safari 原生) 或 MJPEG 等浏览器原生支持的格式: 直接作为视频源播放
        await this.startDirectStream(url);
      }

      this.capturing = true;
      this.onCaptureChange?.(true);
      this.startFrameLoop();
      console.log("[Camera] Network stream started");
    } catch (e: unknown) {
      console.error("[Camera] Failed to start network stream:", e);
      alert("网络流连接失败: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  private detectStreamType(url: string): "flv" | "hls" | "direct" {
    const lowerUrl = url.toLowerCase().split("?")[0];
    if (lowerUrl.endsWith(".flv") || url.includes(".flv?") || url.includes(".live.flv")) {
      return "flv";
    }
    if (lowerUrl.endsWith(".m3u8")) return "hls";
    return "direct";
  }

  private async startFlvStream(url: string): Promise<void> {
    const videoEl = this.getVideoEl();
    if (!videoEl) return;
    const flvjs = (await import("flv.js")).default;
    if (!flvjs.isSupported()) {
      throw new Error("Your browser does not support FLV playback.");
    }

    this.flvPlayer = flvjs.createPlayer(
      { type: "flv", url, isLive: true, hasAudio: false, hasVideo: true },
      {
        enableWorker: false,
        enableStashBuffer: false,
        stashInitialSize: 128,
        lazyLoad: false,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 5,
        autoCleanupMinBackwardDuration: 3,
      },
    );

    this.flvPlayer.attachMediaElement(videoEl);
    this.flvPlayer.load();
    this.flvPlayer.on(flvjs.Events.ERROR, (errType: string, errDetail: string) => {
      console.error("[FLV] Error:", errType, errDetail);
    });

    await videoEl.play();
  }

  private async startDirectStream(url: string): Promise<void> {
    const videoEl = this.getVideoEl();
    if (!videoEl) return;
    videoEl.src = url;
    await videoEl.play();
  }

  /** 停止采集 */
  stop(): void {
    this.capturing = false;

    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.adjustTimer) {
      clearInterval(this.adjustTimer);
      this.adjustTimer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.flvPlayer) {
      try {
        this.flvPlayer.pause();
        this.flvPlayer.unload();
        this.flvPlayer.detachMediaElement();
        this.flvPlayer.destroy();
      } catch (e) {
        console.warn("[Camera] FLV player cleanup error:", e);
      }
      this.flvPlayer = null;
    }

    const videoEl = this.getVideoEl();
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.removeAttribute("src");
      videoEl.load(); // 重置 video 元素
    }
    this.onCaptureChange?.(false);
    console.log("[Camera] Stopped");
  }

  /** 组件卸载时的整体清理（含未使用的 pending 权限流） */
  destroy(): void {
    this.stop();
    if (this.pendingStream) {
      this.pendingStream.getTracks().forEach((t) => t.stop());
      this.pendingStream = null;
    }
  }

  /**
   * 帧发送循环 (事件驱动 + 预编码，最大化吞吐)
   *
   * 策略: 在等待后端响应期间预先编码下一帧 (toBlob),
   * 响应到达后立即发送预编码好的 blob, 消除 idle 等待。
   */
  private startFrameLoop(): void {
    if (this.frameTimer) clearInterval(this.frameTimer);
    if (this.adjustTimer) clearInterval(this.adjustTimer);
    this.pendingBlob = null;

    // 定时预编码: 持续捕获最新帧备用
    this.frameTimer = setInterval(() => {
      if (!this.capturing || !this.sink.connected) return;
      this.preEncode();
    }, this.sink.frameInterval);

    // 动态调整预编码频率
    this.adjustTimer = setInterval(() => {
      if (this.frameTimer && this.capturing) {
        clearInterval(this.frameTimer);
        this.frameTimer = setInterval(() => {
          if (!this.capturing || !this.sink.connected) return;
          this.preEncode();
        }, this.sink.frameInterval);
      }
    }, 2000);
  }

  /** 预编码当前帧 (不发送, 仅保存 blob) */
  private preEncode(): void {
    const videoEl = this.getVideoEl();
    if (!videoEl || videoEl.readyState < 2 || !this.captureCtx) return;

    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (vw > 0 && vh > 0) {
      const targetW = Math.min(this.maxCaptureWidth, vw);
      const targetH = Math.round(targetW * (vh / vw));
      if (this.captureCanvas.width !== targetW || this.captureCanvas.height !== targetH) {
        this.captureCanvas.width = targetW;
        this.captureCanvas.height = targetH;
      }
    }

    this.captureCtx.drawImage(videoEl, 0, 0, this.captureCanvas.width, this.captureCanvas.height);
    this.captureCanvas.toBlob(
      (blob) => {
        if (blob) {
          this.pendingBlob = blob;
          // 如果没有帧在飞行中, 立即发送
          this.trySendPending();
        }
      },
      "image/jpeg",
      0.7,
    );
  }

  /** 尝试发送预编码好的帧 (由预编码回调和 onResultReceived 触发) */
  private trySendPending(): void {
    if (this.pendingBlob && !this.sink.pendingFrame && this.sink.connected) {
      const blob = this.pendingBlob;
      this.pendingBlob = null;
      this.sink.sendFrame(blob);
      // 发送后立即开始编码下一帧 (与后端处理并行)
      this.preEncode();
    }
  }

  /** 后端结果到达时调用 (由 VisionSocket 在 frame_result 中触发) */
  onResultReceived(): void {
    if (this.pendingBlob) {
      this.trySendPending();
    } else {
      // 没有预编码好的帧, 立即开始编码
      this.preEncode();
    }
  }

  /** 获取当前视频尺寸 (用于 Canvas overlay 坐标映射) */
  getVideoRect(): VideoRect | null {
    const videoEl = this.getVideoEl();
    const container = this.getContainer();
    if (!videoEl || !container || !videoEl.videoWidth) return null;

    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    // 1. 计算浏览器实际渲染的视频区域 (保持原始比例)
    const origVideoW = videoEl.videoWidth;
    const origVideoH = videoEl.videoHeight;
    const scale = Math.min(containerW / origVideoW, containerH / origVideoH);

    const displayW = origVideoW * scale;
    const displayH = origVideoH * scale;

    return {
      offsetX: (containerW - displayW) / 2,
      offsetY: (containerH - displayH) / 2,
      displayW, displayH, scale,
      // 2. 导出 capture 尺寸供 OverlayRenderer 用作坐标基准
      videoW: this.captureCanvas.width,
      videoH: this.captureCanvas.height,
    };
  }
}
