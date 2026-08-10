/**
 * 会话原始音频列表对话框（VAD 调试）
 *
 * 展示某会话经「原始音频录制」落 COS 的所有分段（1s 无新数据切段）：
 * 段起始时间、时长、VAD 激活区间（可能为空——VAD 一直没激活）与对应
 * trace_id，内嵌播放器与下载链接。数据来源见后端
 * GET /api/conversations/sessions/{id}/raw_audio。
 */
import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchRawAudioList,
  deleteRawAudio,
  testSessionAudio,
  testSessionAudioUpload,
  testSessionAudioStop,
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

export function RawAudioDialog({ sessionId, deviceSn, onClose, onSelectTrace }: {
  sessionId: number;
  deviceSn: string;
  onClose: () => void;
  /** 点击 VAD 区间：按 trace_id 选中对应的对话记录（可选） */
  onSelectTrace?: (traceId: string) => void;
}) {
  const [items, setItems] = useState<RawAudioItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null); // 删除中的 wav_key
  // 回放中的 wav_key；本地上传文件回放时为 UPLOAD_KEY
  const [replayKey, setReplayKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const UPLOAD_KEY = "__upload__";

  // 回放按录音真实节奏进行，前端按时长到点自动恢复按钮（+2s 补的静音尾余量）
  const markReplaying = (key: string, durationMs: number) => {
    setReplayKey(key);
    window.setTimeout(
      () => setReplayKey((k) => (k === key ? null : k)),
      durationMs + 2000,
    );
  };

  // 回放整段链路：音频从识别器入口喂入，VAD/ASR/对话与设备真实拾音完全一致
  const handleReplay = async (it: RawAudioItem) => {
    try {
      await testSessionAudio(sessionId, deviceSn, it.wav_key);
      markReplaying(it.wav_key, it.duration_ms);
    } catch (e: any) {
      alert(e.message || String(e));
    }
  };

  // 本地 WAV 文件回放（如下载后剪辑过的录音），链路与上面完全相同
  const handleUploadReplay = async (file: File) => {
    try {
      const durationMs = await testSessionAudioUpload(sessionId, deviceSn, file);
      markReplaying(UPLOAD_KEY, durationMs);
    } catch (e: any) {
      alert(e.message || String(e));
    }
  };

  const handleStopReplay = async () => {
    try {
      await testSessionAudioStop(sessionId, deviceSn);
    } catch (e: any) {
      alert(e.message || String(e));
    }
    setReplayKey(null);
  };

  const handleDelete = async (it: RawAudioItem) => {
    if (!window.confirm("确定删除这段录音？COS 上的音频和元数据将一并删除，不可恢复。")) return;
    setDeleting(it.wav_key);
    try {
      await deleteRawAudio(sessionId, it.wav_key);
      setItems((prev) => prev?.filter((x) => x.wav_key !== it.wav_key) ?? prev);
    } catch (e: any) {
      alert(e.message || String(e));
    } finally {
      setDeleting(null);
    }
  };

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
          <span className="raw-audio-title">🎞️ 原始音频</span>
          <button
            className={`roster-refresh raw-audio-upload ${replayKey === UPLOAD_KEY ? "on" : ""}`}
            data-tip={replayKey === UPLOAD_KEY
              ? "停止回放"
              : "选择本地 WAV 文件回放到在线会话（16-bit PCM，链路与设备拾音一致）"}
            onClick={() => (replayKey === UPLOAD_KEY
              ? handleStopReplay()
              : fileInputRef.current?.click())}
          >
            {replayKey === UPLOAD_KEY ? "⏹ 停止回放" : "⬆ 回放本地文件"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".wav,audio/wav,audio/x-wav"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ""; // 允许连续选同一个文件
              if (f) handleUploadReplay(f);
            }}
          />
          <button className="roster-refresh" onClick={load} disabled={loading}>
            {loading ? <span className="spinner inline" /> : "🔄 刷新"}
          </button>
          <button className="roster-close" onClick={onClose} data-tip="关闭 (Esc)">×</button>
        </h3>
        <div className="raw-audio-subtitle">
          会话 #{sessionId} · 设备 {deviceSn} · VAD 前原始拾音，1s 无数据自动分段，最新在前
        </div>

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
                <button
                  className={`raw-audio-replay ${replayKey === it.wav_key ? "on" : ""}`}
                  data-tip={replayKey === it.wav_key
                    ? "停止回放"
                    : "回放到在线会话：走与设备拾音完全一致的 VAD→ASR→对话链路"}
                  onClick={() => (replayKey === it.wav_key ? handleStopReplay() : handleReplay(it))}
                >
                  {replayKey === it.wav_key ? "⏹ 停止回放" : "▶ 回放链路"}
                </button>
                <a
                  className="raw-audio-download"
                  href={mediaUrl(it.wav_key, true)}
                  data-tip="下载 WAV"
                >⬇ 下载</a>
                <button
                  className="raw-audio-delete"
                  disabled={deleting === it.wav_key}
                  data-tip="删除这段录音（COS 上的音频与元数据一并删除）"
                  onClick={() => handleDelete(it)}
                >
                  {deleting === it.wav_key ? <span className="spinner inline" /> : "🗑 删除"}
                </button>
              </div>

              <audio controls preload="none" className="raw-audio-player" src={mediaUrl(it.wav_key)} />

              <div className="raw-audio-vad">
                {it.vad_intervals.length === 0 ? (
                  <span className="raw-audio-novad" data-tip="本段内 VAD 从未激活（纯静音/噪声未触发）">
                    VAD 未激活
                  </span>
                ) : (
                  it.vad_intervals.map((iv, i) => {
                    const clickable = !!(iv.trace_id && onSelectTrace);
                    return (
                      <div
                        className={`raw-audio-interval ${clickable ? "jump" : ""}`}
                        key={i}
                        data-tip={iv.trace_id
                          ? `trace: ${iv.trace_id}${clickable ? "（点击选中这条对话记录）" : ""}`
                          : "录制开始前已在途的语音（无对应轮次）"}
                        onClick={() => iv.trace_id && onSelectTrace?.(iv.trace_id)}
                      >
                        <span className="raw-audio-interval-range">
                          🎤 {formatDuration(iv.start_ms)} → {formatDuration(iv.end_ms)}
                        </span>
                        <span className={`raw-audio-interval-query ${iv.query ? "" : "muted"}`}>
                          {iv.query
                            ? iv.query
                            : iv.query === "" ? "（拾音未识别）" : "（无对应轮次）"}
                        </span>
                      </div>
                    );
                  })
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
