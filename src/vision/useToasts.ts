/**
 * 轻量 toast 状态管理（成功绿色 / 失败红色，自动消失）。
 *
 * VisionView 持有 showToast，经 VisionContext 下发给各面板；
 * 渲染见 Toast.tsx 的 ToastContainer。
 */
import { useCallback, useRef, useState } from "react";
import type { ToastType } from "./context";

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  leaving: boolean;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);

  const showToast = useCallback(
    (message: string, type: ToastType = "success", duration = 3000) => {
      const id = nextIdRef.current++;
      setToasts((prev) => [...prev, { id, message, type, leaving: false }]);
      // 消失前 300ms 加 toast-out 类走淡出动画，与原生实现一致
      setTimeout(() => {
        setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 300);
      }, duration);
    },
    [],
  );

  return { toasts, showToast };
}
