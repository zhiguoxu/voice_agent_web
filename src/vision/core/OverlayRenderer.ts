/**
 * Canvas 叠加层渲染（从 person_id/frontend/js/overlay-renderer.js 移植）。
 *
 * 在视频画面上方绘制检测框 / 骨骼关键点 / 人物标签 / 追踪轨迹 /
 * 注意力目标高亮 / 姿态角标。帧结果 10~30fps 更新，
 * 为避免高频 React 重渲染，本类完全走命令式 Canvas 绘制。
 */
import type { TrackedPerson, VideoRect } from "../types";

export interface OverlayOptions {
  showBbox: boolean;
  showSkeleton: boolean;
  showTrail: boolean;
  showLabels: boolean;
}

// COCO 骨骼连线拓扑
const SKELETON_PAIRS: Array<[number, number]> = [
  [5, 6], // 左肩-右肩
  [5, 11], [6, 12], // 肩-髋
  [11, 12], // 左髋-右髋
  [5, 7], [7, 9], // 左臂
  [6, 8], [8, 10], // 右臂
  [11, 13], [13, 15], // 左腿
  [12, 14], [14, 16], // 右腿
  [0, 1], [0, 2], // 鼻-眼
  [1, 3], [2, 4], // 眼-耳
];

const COLORS: Record<string, string> = {
  confirmed: "#00ff88",
  identifying: "#ffa500",
  suspected: "#ff6b6b",
  stranger: "#6b7280",
  spatial_inferred: "#ffeb3b",
  target_glow: "#00e5ff",
  skeleton_high: "rgba(0, 255, 136, 0.8)",
  skeleton_low: "rgba(100, 100, 100, 0.4)",
};

export class OverlayRenderer {
  persons: TrackedPerson[] = [];
  options: OverlayOptions = {
    showBbox: true,
    showSkeleton: true,
    showTrail: true,
    showLabels: true,
  };

  private getCanvas: () => HTMLCanvasElement | null;
  private getContainer: () => HTMLElement | null;
  /** 坐标基准：拉流观看模式用 StreamViewer，否则用本地采集 */
  private getRect: () => VideoRect | null;

  constructor(
    getCanvas: () => HTMLCanvasElement | null,
    getContainer: () => HTMLElement | null,
    getRect: () => VideoRect | null,
  ) {
    this.getCanvas = getCanvas;
    this.getContainer = getContainer;
    this.getRect = getRect;
  }

  setOption(key: keyof OverlayOptions, value: boolean): void {
    this.options[key] = value;
    this.render();
  }

  /** 更新并重绘叠加层 */
  update(persons: TrackedPerson[]): void {
    this.persons = persons || [];
    this.render();
  }

  /** 命中测试：canvas 点击坐标 → 被点中的人（自上而下优先） */
  hitTest(clientX: number, clientY: number): TrackedPerson | null {
    const canvas = this.getCanvas();
    const rect = this.getRect();
    if (!canvas || !rect || !this.persons.length) return null;

    const canvasRect = canvas.getBoundingClientRect();
    const clickX = clientX - canvasRect.left;
    const clickY = clientY - canvasRect.top;

    for (let i = this.persons.length - 1; i >= 0; i--) {
      const person = this.persons[i];
      const [x1, y1, x2, y2] = this.normToPixel(person.bbox, rect);
      const padding = 10; // 容错内边距，方便点中
      if (
        clickX >= x1 - padding && clickX <= x2 + padding &&
        clickY >= y1 - padding && clickY <= y2 + padding
      ) {
        return person;
      }
    }
    return null;
  }

  render(): void {
    const canvas = this.getCanvas();
    const container = this.getContainer();
    if (!canvas || !container) return;
    const rect = this.getRect();
    if (!rect) return;

    // 同步 canvas 尺寸
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const person of this.persons) {
      const color = this.getColor(person);
      const bbox = this.normToPixel(person.bbox, rect);

      if (this.options.showTrail && person.trail && person.trail.length > 1) {
        this.drawTrail(ctx, person.trail, rect, color);
      }
      if (this.options.showBbox) {
        this.drawBbox(ctx, bbox, color, !!person.is_current_target);
      }
      if (this.options.showSkeleton && person.keypoints) {
        this.drawSkeleton(ctx, person.keypoints, rect);
      }
      if (this.options.showLabels) {
        this.drawLabel(ctx, canvas, bbox, person, color);
        this.drawPoseBadge(ctx, canvas, bbox, person.pose_bucket);
      }
    }
  }

  private getColor(person: TrackedPerson): string {
    const status = person.identity_status || person.status || "identifying";
    return COLORS[status] || COLORS.identifying;
  }

  private normToPixel(bbox: number[] | undefined, rect: VideoRect): number[] {
    if (!bbox || bbox.length < 4) return [0, 0, 0, 0];
    // 检测坐标基于发送帧 (rect.videoW x rect.videoH)
    const scaleX = rect.displayW / rect.videoW;
    const scaleY = rect.displayH / rect.videoH;
    return [
      rect.offsetX + bbox[0] * scaleX,
      rect.offsetY + bbox[1] * scaleY,
      rect.offsetX + bbox[2] * scaleX,
      rect.offsetY + bbox[3] * scaleY,
    ];
  }

  private drawBbox(
    ctx: CanvasRenderingContext2D,
    bbox: number[],
    color: string,
    isTarget: boolean,
  ): void {
    const [x1, y1, x2, y2] = bbox;

    if (isTarget) {
      // 发光外框
      ctx.strokeStyle = COLORS.target_glow;
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      ctx.strokeRect(x1 - 3, y1 - 3, x2 - x1 + 6, y2 - y1 + 6);
      // 角落装饰
      ctx.lineWidth = 3;
      this.drawCorners(ctx, x1 - 3, y1 - 3, x2 - x1 + 6, y2 - y1 + 6, 15);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  }

  private drawCorners(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, len: number,
  ): void {
    ctx.beginPath();
    // Top-left
    ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
    // Top-right
    ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
    // Bottom-left
    ctx.moveTo(x, y + h - len); ctx.lineTo(x, y + h); ctx.lineTo(x + len, y + h);
    // Bottom-right
    ctx.moveTo(x + w - len, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - len);
    ctx.stroke();
  }

  private drawSkeleton(
    ctx: CanvasRenderingContext2D,
    keypoints: number[][],
    rect: VideoRect,
  ): void {
    const scaleX = rect.displayW / rect.videoW;
    const scaleY = rect.displayH / rect.videoH;
    const toX = (v: number) => rect.offsetX + v * scaleX;
    const toY = (v: number) => rect.offsetY + v * scaleY;

    // 骨骼连线
    for (const [i, j] of SKELETON_PAIRS) {
      const kp1 = keypoints[i];
      const kp2 = keypoints[j];
      if (!kp1 || !kp2) continue;
      const conf = Math.min(kp1[2] || 0, kp2[2] || 0);
      if (conf < 0.2) continue;

      ctx.beginPath();
      ctx.moveTo(toX(kp1[0]), toY(kp1[1]));
      ctx.lineTo(toX(kp2[0]), toY(kp2[1]));
      ctx.strokeStyle = conf > 0.5 ? COLORS.skeleton_high : COLORS.skeleton_low;
      ctx.lineWidth = conf > 0.5 ? 2 : 1;
      ctx.stroke();
    }

    // 关键点
    for (const kp of keypoints) {
      if (!kp || (kp[2] || 0) < 0.2) continue;
      const r = kp[2] > 0.5 ? 3 : 2;
      ctx.beginPath();
      ctx.arc(toX(kp[0]), toY(kp[1]), r, 0, Math.PI * 2);
      ctx.fillStyle = kp[2] > 0.5 ? COLORS.skeleton_high : COLORS.skeleton_low;
      ctx.fill();
    }
  }

  private drawLabel(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    bbox: number[],
    person: TrackedPerson,
    color: string,
  ): void {
    const status = person.identity_status || person.status || "identifying";

    let name: string;
    if (status === "stranger") {
      name = "Unknown";
    } else if (status === "suspected") {
      const rawName = person.display_name || person.person_id || "?";
      name = `Suspect (${rawName})`;
    } else {
      name = person.display_name || person.person_id || "Unknown";
    }

    const conf = person.confidence ? ` ${(person.confidence * 100).toFixed(0)}%` : "";
    const trackId = person.track_id !== undefined ? `[#${person.track_id}] ` : "";
    const text = `${trackId}${name}${conf}`;

    ctx.font = "600 12px Inter, sans-serif";
    const textW = ctx.measureText(text).width + 12;
    const textH = 20;
    const gap = 4;

    let x = bbox[0];
    let y = bbox[1] - textH - gap;
    // 边界保护: 上方放不下 → 放到框内顶部
    if (y < 0) y = bbox[1] + gap;
    if (x + textW > canvas.width) x = canvas.width - textW;
    if (x < 0) x = 0;

    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.beginPath();
    ctx.roundRect(x, y, textW, textH, 4);
    ctx.fill();

    // 左侧色条
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 3, textH);

    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x + 8, y + 14);
  }

  private drawPoseBadge(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    bbox: number[],
    poseBucket: string | undefined,
  ): void {
    if (!poseBucket || poseBucket === "unknown") return;

    const badgeMap: Record<string, string> = {
      frontal: "👤",
      left: "◀",
      right: "▶",
      back: "🔙",
    };
    const emoji = badgeMap[poseBucket] || "?";
    const badgeW = 22;
    const badgeH = 16;

    let x = bbox[2] + 4;
    let y = bbox[1] + 4;
    if (x + badgeW > canvas.width) x = bbox[2] - badgeW - 4;
    if (y < 0) y = 0;
    if (y + badgeH > canvas.height) y = canvas.height - badgeH;

    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.beginPath();
    ctx.roundRect(x, y, badgeW, badgeH, 3);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "10px sans-serif";
    ctx.fillText(emoji, x + 4, y + 12);
  }

  private drawTrail(
    ctx: CanvasRenderingContext2D,
    trail: number[][],
    rect: VideoRect,
    color: string,
  ): void {
    if (trail.length < 2) return;
    const scaleX = rect.displayW / rect.videoW;
    const scaleY = rect.displayH / rect.videoH;

    ctx.beginPath();
    for (let i = 0; i < trail.length; i++) {
      const x = rect.offsetX + trail[i][0] * scaleX;
      const y = rect.offsetY + trail[i][1] * scaleY;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }
}
