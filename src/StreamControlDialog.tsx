import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchStreamStatus,
  startStreamConsume,
  stopStreamConsume,
  type StreamStatusData,
} from "./api";
import "./RosterDialog.css";
import "./StreamControlDialog.css";

/** 拉流状态归一化为四档展示口径（与后端约定：拉流中 = running 且 connected） */
export type StreamState = "on" | "warn" | "off" | "unknown";

export function deriveStreamState(data: StreamStatusData | null): StreamState {
  if (!data || !data.enabled || !data.reachable) return "unknown";
  const s = data.status;
  if (s?.running && s.connected) return "on";
  if (s?.running) return "warn";
  return "off";
}

const STATE_TEXT: Record<StreamState, string> = {
  on: "拉流中",
  warn: "已开启，视频流未连上（重连/恢复中）",
  off: "未拉流",
  unknown: "拉流状态未知（person_id 服务不可达）",
};

/**
 * 摄像头拉流控制对话框：展示 person_id 服务端对该设备视频流的消费状态
 * （camera_id = device_sn），并可开启/关闭拉流。
 *
 * 开启 = 经 ISS 让设备推流 + person_id 服务端消费该流；关闭 = 先停消费再停
 * 设备推流。打开期间每 1 秒轮询一次状态；启停结果立即回填。
 */
export function StreamControlDialog({ deviceSn, onClose, onStatusChange }: {
  deviceSn: string;
  onClose: () => void;
  /** 状态变化时回传给父级（会话头部的指示灯与弹窗保持同步） */
  onStatusChange?: (data: StreamStatusData) => void;
}) {
  const [data, setData] = useState<StreamStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [env, setEnv] = useState(() => localStorage.getItem("streamIssEnv") || "test");
  // 启停请求进行中时轮询结果直接丢弃，避免旧快照盖掉操作结果
  const actionLoadingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const d = await fetchStreamStatus(deviceSn);
      if (actionLoadingRef.current) return;
      setData(d);
      onStatusChange?.(d);
    } catch {
      /* 轮询失败保留上次快照，下轮再试 */
    } finally {
      setLoading(false);
    }
  }, [deviceSn, onStatusChange]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const state = deriveStreamState(data);
  const status = data?.status ?? null;
  const running = !!status?.running;

  const doAction = async (action: "start" | "stop") => {
    setActionLoading(true);
    actionLoadingRef.current = true;
    setActionError(null);
    try {
      const s = action === "start"
        ? await startStreamConsume(deviceSn, env)
        : await stopStreamConsume(deviceSn, env);
      const d: StreamStatusData = { enabled: true, reachable: true, status: s };
      setData(d);
      onStatusChange?.(d);
    } catch (e: any) {
      setActionError(e.message || String(e));
    } finally {
      setActionLoading(false);
      actionLoadingRef.current = false;
    }
  };

  return (
    <div className="roster-dialog-overlay" onClick={onClose}>
      <div className="roster-dialog stream-control-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>
          📡 摄像头拉流
          <span className="subtitle">设备 {deviceSn}</span>
          <button className="roster-close" onClick={onClose} data-tip="关闭 (Esc)">×</button>
        </h3>

        <div className="roster-dialog-body">
          {loading ? (
            <div className="stream-loading"><span className="spinner inline" /> 查询拉流状态…</div>
          ) : !data?.enabled ? (
            <div className="stream-state-line">人物识别能力未开启（person_id.enabled=false），无法拉流。</div>
          ) : (
            <>
              <div className={`stream-state-line ${state}`}>
                <span className={`stream-dot ${state}`} />
                {STATE_TEXT[state]}
              </div>

              {status && running && (
                <div className="stream-detail-grid">
                  <label>直播地址</label>
                  <span className="stream-url" title={status.url ?? ""}>{status.url || "-"}</span>
                  <label>分辨率</label>
                  <span>
                    {status.stream_width > 0
                      ? `${status.stream_width} × ${status.stream_height}`
                      : "-（尚未连上流）"}
                  </span>
                  <label>帧统计</label>
                  <span>已读 {status.frames_read} / 已处理 {status.frames_processed}（{status.process_fps.toFixed(1)} fps）</span>
                  <label>ISS 环境</label>
                  <span>{status.env}{status.auto_restream ? "，断流自动重推" : ""}
                    {status.restream_count > 0 ? `（已重推 ${status.restream_count} 次）` : ""}
                  </span>
                  {status.recovering && (
                    <>
                      <label>恢复中</label>
                      <span>断流恢复流程（设备在线检查 / ISS 重推）进行中…</span>
                    </>
                  )}
                  {status.last_error && (
                    <>
                      <label>最近错误</label>
                      <span className="stream-error-text">{status.last_error}</span>
                    </>
                  )}
                </div>
              )}

              <div className="stream-actions">
                {!running && (
                  <label className="stream-env-select">
                    ISS 环境
                    <select
                      value={env}
                      disabled={actionLoading}
                      onChange={(e) => {
                        setEnv(e.target.value);
                        localStorage.setItem("streamIssEnv", e.target.value);
                      }}
                    >
                      <option value="test">test</option>
                      <option value="prod">prod</option>
                    </select>
                  </label>
                )}
                <button
                  className={`roster-save-btn stream-toggle-btn ${running ? "stop" : "start"}`}
                  disabled={actionLoading || state === "unknown"}
                  data-tip={state === "unknown" ? "person_id 服务不可达，无法操作" : undefined}
                  onClick={() => doAction(running ? "stop" : "start")}
                >
                  {actionLoading
                    ? <span className="spinner inline" />
                    : running ? "⏹ 关闭拉流" : "▶ 开启拉流"}
                </button>
              </div>

              {actionError && (
                <div className="stream-action-error">❌ {actionError}</div>
              )}
              <p className="stream-hint">
                开启 = 让设备开始推流（ISS）并由识别服务拉取该视频流；人脸识别、
                注册人脸都依赖拉流中的画面。关闭会先停服务端消费、再停设备推流。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
