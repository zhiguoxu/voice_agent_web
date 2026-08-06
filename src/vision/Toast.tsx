/**
 * toast 渲染容器（状态管理见 useToasts.ts）。
 */
import type { ToastItem } from "./useToasts";

export function ToastContainer({ toasts }: { toasts: ToastItem[] }) {
  if (toasts.length === 0) return null;
  return (
    <div id="toast-box">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type} ${t.leaving ? "toast-out" : ""}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
