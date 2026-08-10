/**
 * 滑动时间窗 FPS：最近 windowMs 内记录的帧数 / 窗长。
 * 分母用墙钟窗口（含安静间隙），不用首末时间戳跨度——突发连画时跨度偏短会虚高。
 */
export class FpsMeter {
  private timestamps: number[] = [];
  private readonly windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  reset(): void {
    this.timestamps = [];
  }

  /** 记录一帧；返回当前吞吐 FPS */
  record(now = performance.now()): number {
    this.timestamps.push(now);
    this.prune(now);
    return this.value(now);
  }

  value(now = performance.now()): number {
    this.prune(now);
    const n = this.timestamps.length;
    if (n === 0) return 0;
    // 窗口未满时用实际经过时间，避免刚启动只有几帧却按满窗低估
    const elapsed = Math.min(this.windowMs, now - this.timestamps[0]!);
    if (elapsed <= 0) return 0;
    return (n * 1000) / elapsed;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
  }
}
