/**
 * 视觉模块内部事件总线。
 *
 * 帧结果 10~30fps 到达，若全部走顶层 React state 会导致整棵组件树高频重渲染。
 * 各面板（Pipeline / 时间线 / 花名册）自行订阅所需事件并局部 setState，
 * 视频叠加层等热路径则完全绕过 React 直接画 Canvas。
 */
import type { FrameResult, TrackedPerson, VisionEvent } from "./types";

export interface VisionBusEvents {
  /** 每帧识别结果（tracked_persons 已展平） */
  frameResult: FrameResult & { tracked_persons: TrackedPerson[] };
  /** 服务端异步事件（identity_* / track_* / data_stale 等） */
  event: VisionEvent;
  /** WS 连接状态变化 */
  connected: boolean;
}

type Handler<T> = (payload: T) => void;

export class VisionBus {
  private handlers = new Map<keyof VisionBusEvents, Set<Handler<never>>>();

  on<K extends keyof VisionBusEvents>(event: K, handler: Handler<VisionBusEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof VisionBusEvents>(event: K, payload: VisionBusEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as Handler<VisionBusEvents[K]>)(payload);
      } catch (e) {
        console.error(`[VisionBus] handler for "${event}" failed:`, e);
      }
    }
  }
}
