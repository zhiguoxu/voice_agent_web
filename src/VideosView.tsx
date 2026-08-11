/**
 * 拉流录像列表：按设备号与开始时间范围查询，支持预览与下载。
 * 数据来自 person_id GET /api/videos。
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchVideoList,
  deleteVideo,
  videoMediaUrl,
  type VideoRecordingItem,
} from "./api";
import { TimeRangePicker, type TimeRange } from "./TimeRangePicker";
import "./VideosView.css";

function formatTime(iso: string | null | undefined) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function VideosView() {
  const [filterSn, setFilterSn] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>({
    start: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    end: "",
  });
  const [items, setItems] = useState<VideoRecordingItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<VideoRecordingItem | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchVideoList({
        device_sn: filterSn.trim() || undefined,
        start_from: timeRange.start || undefined,
        start_to: timeRange.end || undefined,
        status: "ready",
        limit: 100,
      });
      setItems(list);
    } catch (e: any) {
      setError(e.message || String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [filterSn, timeRange.start, timeRange.end]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async (it: VideoRecordingItem) => {
    if (!confirm(`删除录像 #${it.id}（${formatTime(it.started_at)}）？`)) return;
    setDeletingId(it.id);
    try {
      await deleteVideo(it.id);
      if (preview?.id === it.id) setPreview(null);
      await load();
    } catch (e: any) {
      alert(e.message || String(e));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="videos-view">
      <div className="videos-toolbar">
        <div className="filter-group">
          <label>设备</label>
          <div className="input-wrap sn">
            <input
              type="text"
              placeholder="device_sn 精确匹配"
              value={filterSn}
              onChange={(e) => setFilterSn(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void load()}
            />
            {filterSn && (
              <button className="input-clear" onClick={() => setFilterSn("")}>×</button>
            )}
          </div>
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
        <button
          className="videos-query-btn"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "加载中…" : "查询"}
        </button>
        <span className="videos-count">
          {items.length > 0 && `${items.length} 条录像`}
        </span>
      </div>

      {error && <div className="videos-error">{error}</div>}

      <div className="videos-layout">
        <div className="videos-list">
          {!loading && items.length === 0 && !error && (
            <div className="videos-empty">
              <div className="videos-empty-icon">🎞️</div>
              该时间范围内暂无录像
            </div>
          )}
          {items.map((it) => (
            <div
              key={it.id}
              className={`videos-card ${preview?.id === it.id ? "active" : ""}`}
              onClick={() => setPreview(it)}
            >
              <div className="videos-card-row">
                <span className="videos-device">{it.device_sn}</span>
                <span className="videos-duration">{formatDuration(it.duration_ms)}</span>
              </div>
              <div className="videos-card-row meta">
                <span className="videos-time">{formatTime(it.started_at)}</span>
                {it.width > 0 && (
                  <span className="videos-res">
                    {it.width}×{it.height} · {it.fps.toFixed(0)}fps
                  </span>
                )}
              </div>
              <div className="videos-card-row bottom">
                <span className="videos-session" title={`拉流会话 ${it.stream_session_id}`}>
                  {it.stream_session_id.slice(0, 8)}
                </span>
                <span className="videos-actions" onClick={(e) => e.stopPropagation()}>
                  <a href={videoMediaUrl(it.id, true)} download>下载</a>
                  <button
                    type="button"
                    className="danger"
                    disabled={deletingId === it.id}
                    onClick={() => void handleDelete(it)}
                  >
                    {deletingId === it.id ? "删除中…" : "删除"}
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="videos-preview">
          {preview ? (
            <>
              <div className="videos-preview-head">
                <div className="videos-preview-title">
                  <h3>{preview.device_sn}</h3>
                  <span className="videos-preview-sub">
                    #{preview.id} · {formatTime(preview.started_at)}
                  </span>
                </div>
                <a
                  className="videos-download-btn"
                  href={videoMediaUrl(preview.id, true)}
                  download
                >
                  ⬇ 下载 MP4
                </a>
              </div>
              <video
                key={preview.id}
                className="videos-player"
                src={videoMediaUrl(preview.id)}
                controls
                playsInline
                preload="metadata"
              />
              <div className="videos-meta-grid">
                <span className="k">时长</span>
                <span className="v">{formatDuration(preview.duration_ms)}</span>
                <span className="k">开始</span>
                <span className="v">{formatTime(preview.started_at)}</span>
                <span className="k">结束</span>
                <span className="v">{formatTime(preview.ended_at)}</span>
                <span className="k">规格</span>
                <span className="v">
                  {preview.width}×{preview.height} @ {preview.fps.toFixed(0)}fps ·{" "}
                  {preview.frame_count} 帧
                </span>
                <span className="k">拉流会话</span>
                <span className="v mono">{preview.stream_session_id}</span>
                <span className="k">COS</span>
                <span className="v mono">{preview.cos_key || "-"}</span>
              </div>
            </>
          ) : (
            <div className="videos-preview-placeholder">
              <div className="videos-empty-icon">▶</div>
              点击左侧录像进行预览
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
