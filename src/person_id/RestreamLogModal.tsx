/**
 * 自动重推流日志弹窗（从 person_id/frontend/js/restream-log.js 移植）。
 *
 * 拉流连续失败触发自动重推流后, 服务端把每次恢复尝试(触发原因、设备在线
 * 检查、ISS 调用结果、每一步错误日志)记在 data/restream_log/ 下。
 * 本弹窗从 GET /api/{camera_id}/device_stream/restream_log 拉取并渲染。
 */
import { useCallback, useEffect, useState } from "react";
import { fetchRestreamLog } from "./api";
import { useVision } from "./context";
import type { RestreamAttempt } from "./types";

const OUTCOME_BADGES: Record<string, { text: string; cls: string }> = {
  restreamed: { text: "✅ 重推成功", cls: "ok" },
  device_offline: { text: "📴 设备不在线", cls: "warn" },
  iss_start_failed: { text: "❌ ISS 开启推流失败", cls: "err" },
  error: { text: "❌ 恢复流程异常", cls: "err" },
};

function fmtTime(epochSec: number | undefined): string {
  if (!epochSec) return "-";
  const d = new Date(epochSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function RestreamLogModal({ onClose }: { onClose: () => void }) {
  const { cameraId } = useVision();
  const [attempts, setAttempts] = useState<RestreamAttempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cameraId) {
      setError("请先填写设备 SN");
      return;
    }
    setAttempts(null);
    setError(null);
    try {
      const data = await fetchRestreamLog(cameraId, 100);
      setAttempts(data.attempts);
    } catch (e: unknown) {
      setError(`加载失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [cameraId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal restream-log-modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-content" style={{ maxWidth: 860 }}>
        <div className="modal-header">
          <h3>🧾 自动重推流日志</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="restream-log-toolbar">
            <span className="restream-log-summary">
              {attempts != null
                ? `设备 ${cameraId} · 最近 ${attempts.length} 次自动重推流记录 (新的在前)`
                : ""}
            </span>
            <button className="btn btn-xs" onClick={() => void load()}>🔄 刷新</button>
          </div>
          <div className="restream-log-list">
            {error ? (
              <div className="restream-log-empty">{error}</div>
            ) : attempts == null ? (
              <div className="restream-log-empty">加载中...</div>
            ) : attempts.length === 0 ? (
              <div className="restream-log-empty">暂无记录: 该设备还没有触发过自动重推流</div>
            ) : (
              attempts.map((a, index) => {
                const badge = OUTCOME_BADGES[a.outcome] || { text: a.outcome, cls: "err" };
                const onlineText = a.device_online === true ? "在线"
                  : a.device_online === false ? "不在线" : "检查失败";
                return (
                  <details key={index} className="restream-attempt" open={index === 0}>
                    <summary>
                      <span className="restream-attempt-time">{fmtTime(a.started_at)}</span>
                      <span className={`restream-badge ${badge.cls}`}>{badge.text}</span>
                      <span className="restream-attempt-meta">
                        连续失败 {a.trigger_fail_count} 次 · 设备{onlineText} · {a.env} 环境
                      </span>
                    </summary>
                    <div className="restream-attempt-detail">
                      <div className="restream-kv">
                        <span>触发错误</span><code>{a.trigger_error || "无"}</code>
                      </div>
                      <div className="restream-kv">
                        <span>旧地址</span><code>{a.old_url || "-"}</code>
                      </div>
                      {a.new_url && (
                        <div className="restream-kv">
                          <span>新地址</span><code>{a.new_url}</code>
                        </div>
                      )}
                      <div className="restream-log-lines">
                        {(a.logs || []).length === 0 ? (
                          <div className="restream-log-line">无过程日志</div>
                        ) : (
                          (a.logs || []).map((l, i) => (
                            <div key={i} className={`restream-log-line restream-log-${l.level}`}>
                              <span className="restream-log-line-time">
                                {fmtTime(l.time).slice(11)}
                              </span>
                              <span>{l.message}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </details>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
