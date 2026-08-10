/**
 * 会话原始音频列表对话框（VAD 调试）
 *
 * 展示某会话经「原始音频录制」落 COS 的所有分段（1s 无新数据切段）：
 * 段起始时间、时长、VAD 激活区间（可能为空——VAD 一直没激活）与对应
 * trace_id，内嵌播放器与下载链接。数据来源见后端
 * GET /api/conversations/sessions/{id}/raw_audio。
 */
import { useState, useEffect, useCallback } from "react";
import {
  fetchRawAudioList,
  type RawAudioItem,
  CONVERSATIONS_API_BASE,
} from "./api";
import "./RawAudioDialog.css";

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN");
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function mediaUrl(key: string, download = false) {
  const sp = new URLSearchParams({ key });
  if (download) sp.set("download", "true");
  return `${CONVERSATIONS_API_BASE}/media?${sp}`;
}

export function RawAudioDialog({ sessionId, deviceSn, onClose, onJumpTrace }: {
  sessionId: number;
  deviceSn: string;
  onClose: () => void;
  /** 点击区间 trace_id 跳转日志页（可选） */
  onJumpTrace?: (traceId: string) => void;
}) {
  const [items, setItems] = useState<RawAudioItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchRawAudioList(sessionId));
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="roster-dialog-overlay" onClick={onClose}>
      <div className="roster-dialog raw-audio-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>
          🎞️ 原始音频录制
          <span className="subtitle">
            会话 #{sessionId} · 设备 {deviceSn} · VAD 前原始拾音，1s 无数据自动分段，最新在前
          </span>
          <button className="roster-refresh" onClick={load} disabled={loading}>
            {loading ? <span className="spinner inline" /> : "🔄 刷新"}
          </button>
          <button className="roster-close" onClick={onClose} data-tip="关闭 (Esc)">×</button>
        </h3>

        <div className="roster-dialog-body">
          {error && <div className="roster-error">❌ {error}</div>}

          {items && items.length === 0 && !loading && (
            <div className="empty">
              该会话暂无录制音频。在线会话点击「开始录制」后，设备上行的拾音会自动分段存入 COS。
            </div>
          )}

          {items && items.map((it) => (
            <div className="raw-audio-card" key={it.wav_key}>
              <div className="raw-audio-head">
                <span className="raw-audio-time">{formatTime(it.start_time)}</span>
                <span className="raw-audio-dur" data-tip="本段时长（按累计采样数折算）">
                  {formatDuration(it.duration_ms)}
                </span>
                <span className="raw-audio-sr">{it.sample_rate / 1000}kHz</span>
                <a
                  className="raw-audio-download"
                  href={mediaUrl(it.wav_key, true)}
                  data-tip="下载 WAV"
                >⬇ 下载</a>
              </div>

              <audio controls preload="none" className="raw-audio-player" src={mediaUrl(it.wav_key)} />

              <div className="raw-audio-vad">
                {it.vad_intervals.length === 0 ? (
                  <span className="raw-audio-novad" data-tip="本段内 VAD 从未激活（纯静音/噪声未触发）">
                    VAD 未激活
                  </span>
                ) : (
                  it.vad_intervals.map((iv, i) => (
                    <span
                      className={`raw-audio-interval ${iv.trace_id && onJumpTrace ? "jump" : ""}`}
                      key={i}
                      data-tip={iv.trace_id
                        ? `trace: ${iv.trace_id}${onJumpTrace ? "（点击跳转日志）" : ""}`
                        : "录制开始前已在途的语音（无 trace）"}
                      onClick={() => iv.trace_id && onJumpTrace?.(iv.trace_id)}
                    >
                      🎤 {formatDuration(iv.start_ms)} → {formatDuration(iv.end_ms)}
                    </span>
                  ))
                )}
              </div>
            </div>
          ))}

          {loading && !items && (
            <div className="empty"><div className="spinner" /></div>
          )}
        </div>
      </div>
    </div>
  );
}
