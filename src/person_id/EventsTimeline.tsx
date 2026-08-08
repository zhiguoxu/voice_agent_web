/**
 * 事件时间线面板（从 person_id/frontend/js/events-timeline.js 移植）。
 *
 * 显示每次 Tier2 匹配结果（identity status + fused score）：
 * - 同一 track 的连续事件合并为一行，水平追加 score badge；状态变化时插入行内状态标签
 * - 点击 score badge 弹出匹配候选详情 popover（含 track 质量帧缓存异步加载）
 * - 支持按 track 过滤: All / Active Tracks
 */
import { useEffect, useRef, useState } from "react";
import { clearQualityCache, fetchQualityCache } from "./api";
import { useVision } from "./context";
import { VisionPortal } from "./VisionPortal";
import type { QualityCache, QualityCacheItem, VisionEvent } from "./types";

const MAX_EVENTS = 50;

type SeqEvent = VisionEvent & { _seq: number };

function statusShort(status: string | undefined | null): string {
  const map: Record<string, string> = {
    // IdentityStatus values (message 字段)
    definite: "DEF",
    confident: "CONF",
    suspected: "SUSP",
    conflict: "CNFL",
    stranger: "STR",
    // EventType values (event_type 字段 fallback)
    new_person: "NEW",
    identity_definite: "DEF",
    identity_confident: "CONF",
    identity_suspected: "SUSP",
    identity_conflict: "CNFL",
    human_confirmed: "HUMAN",
    vlm_result: "VLM",
    vlm_invoked: "VLM",
    track_lost: "LOST",
    track_recovered: "RECV",
    data_stale: "STALE",
  };
  return map[status ?? ""] || status?.toUpperCase()?.slice(0, 4) || "?";
}

function statusClass(status: string | undefined | null): string {
  const map: Record<string, string> = {
    definite: "definite",
    confident: "confident",
    suspected: "suspected",
    conflict: "conflict",
    stranger: "stranger",
    new_person: "stranger",
    identity_definite: "definite",
    identity_confident: "confident",
    identity_suspected: "suspected",
    identity_conflict: "conflict",
    human_confirmed: "definite",
    vlm_result: "confident",
    vlm_invoked: "confident",
    track_lost: "stranger",
    track_recovered: "suspected",
    data_stale: "stale",
  };
  return map[status ?? ""] || "default";
}

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/* ── 合并后的 track 卡片派生结构 ── */

type ScoreItem =
  | { kind: "stale"; seq: number }
  | { kind: "status"; seq: number; status: string }
  | { kind: "score"; seq: number; event: SeqEvent };

interface TrackCard {
  trackKey: string;
  trackId: number | null;
  firstEvent: SeqEvent;
  lastEvent: SeqEvent;
  lastSeq: number;
  items: ScoreItem[];
}

function buildCards(
  events: SeqEvent[],
  clearedMarks: Record<string, number>,
): TrackCard[] {
  // events 为最新在前；按时间正序遍历合并
  const byTrack = new Map<string, TrackCard>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const trackKey = `${event.track_id}`;
    let card = byTrack.get(trackKey);
    if (!card) {
      card = {
        trackKey,
        trackId: event.track_id ?? null,
        firstEvent: event,
        lastEvent: event,
        lastSeq: event._seq,
        items: [],
      };
      byTrack.set(trackKey, card);
    }
    card.lastEvent = event;
    card.lastSeq = event._seq;

    // 「清理缓存」之前的 score 项不再展示（卡片头部保留）
    if (event._seq <= (clearedMarks[trackKey] ?? -1)) continue;

    if (event.event_type === "data_stale") {
      // 避免连续追加多个 stale 标记
      const last = card.items[card.items.length - 1];
      if (!(last && last.kind === "stale")) {
        card.items.push({ kind: "stale", seq: event._seq });
      }
      continue;
    }

    const currentStatus = event.message || event.event_type;
    // 状态变化 → 插入行内状态标签
    const lastStatusItem = [...card.items].reverse().find((it) => it.kind === "status");
    const prevScore = [...card.items].reverse().find((it) => it.kind === "score");
    const prevStatus = lastStatusItem?.kind === "status"
      ? lastStatusItem.status
      : prevScore?.kind === "score"
        ? (prevScore.event.message || prevScore.event.event_type)
        : null;
    if (prevStatus !== null && currentStatus !== prevStatus) {
      card.items.push({ kind: "status", seq: event._seq, status: currentStatus });
    }
    card.items.push({ kind: "score", seq: event._seq, event });
  }

  // 最新活动的 track 在最上
  return [...byTrack.values()].sort((a, b) => b.lastSeq - a.lastSeq);
}

/* ── 匹配候选详情 popover ── */

function CandidatesPopover({ anchor, event, onClose }: {
  anchor: DOMRect;
  event: SeqEvent;
  onClose: () => void;
}) {
  const { cameraId, qualityThresholds } = useVision();
  const popRef = useRef<HTMLDivElement>(null);
  const [cache, setCache] = useState<QualityCache | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);

  // 异步加载 quality cache
  useEffect(() => {
    if (!cameraId || event.track_id == null) {
      setCacheError("—");
      return;
    }
    let stale = false;
    fetchQualityCache(cameraId, event.track_id)
      .then((data) => { if (!stale) setCache(data); })
      .catch(() => { if (!stale) setCacheError("Cache not available"); });
    return () => { stale = true; };
  }, [cameraId, event.track_id]);

  // 定位：锚点下方，超出视口时收回
  useEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    pop.style.left = `${anchor.left}px`;
    pop.style.top = `${anchor.bottom + 4}px`;
    requestAnimationFrame(() => {
      const rect = pop.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        pop.style.left = `${window.innerWidth - rect.width - 8}px`;
      }
      if (rect.bottom > window.innerHeight - 8) {
        pop.style.top = `${Math.max(8, anchor.top - rect.height - 4)}px`;
      }
    });
  }, [anchor, cache]);

  // 点击 popover 外部关闭
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener("click", onDocClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", onDocClick);
    };
  }, [onClose]);

  const candidates = event.candidates || [];
  let headerText = `Match Details — Track #${event.track_id}`;
  if (candidates.length >= 2) {
    const top1 = candidates[0].fused_score || 0;
    const top2 = candidates[1].fused_score || 0;
    headerText += ` | margin: ${(top1 - top2).toFixed(3)}`;
  }

  const fmt = (v: number | undefined) => (v != null ? v.toFixed(3) : "—");

  const renderPool = (title: string, pool: QualityCacheItem[], poolType: "face" | "body") => {
    const minQ = poolType === "body" ? qualityThresholds.body : qualityThresholds.face;
    return (
      <div className="pop-cache-pool">
        <div className="pop-cache-pool-header">{title} ({pool.length})</div>
        <div className="pop-cache-grid">
          {pool.map((item, i) => (
            <div key={i} className={`pop-cache-card${item.enrolled ? " enrolled" : ""}`}>
              <img
                className="pop-cache-img"
                src={`data:image/jpeg;base64,${item.image_b64}`}
                alt={item.pose_bucket}
              />
              <div className="pop-cache-info">
                <span className={`pop-cache-quality pop-cache-q-${item.quality < minQ ? "low" : "high"}`}>
                  Q: {item.quality.toFixed(2)}
                </span>
                <span className="pop-cache-pose">{item.pose_bucket}</span>
                <span className="pop-cache-time">{formatTime(item.timestamp)}</span>
                {item.enrolled && <span className="pop-cache-enrolled">✓</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const facePool = cache?.face_pool || [];
  const bodyPool = cache?.body_pool || [];

  return (
    <div className="event-popover" ref={popRef} onClick={(e) => e.stopPropagation()}>
      <div className="event-popover-header">
        <span>{headerText}</span>
        <button className="event-popover-close" onClick={onClose}>&times;</button>
      </div>
      <table className="event-popover-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Fused</th>
            <th>Face</th>
            <th>Body</th>
            <th>Prop</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c, i) => (
            <tr key={i}>
              <td className="pop-name">{c.display_name || c.person_id || "?"}</td>
              <td className="pop-fused">{fmt(c.fused_score)}</td>
              <td>{fmt(c.face_score)}</td>
              <td>{fmt(c.body_score)}</td>
              <td>{fmt(c.proportion_score)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pop-cache-section">
        {cacheError ? (
          <div className="pop-cache-empty">{cacheError}</div>
        ) : !cache ? (
          <div className="pop-cache-loading">Loading quality cache…</div>
        ) : facePool.length === 0 && bodyPool.length === 0 ? (
          <div className="pop-cache-empty">Quality cache empty</div>
        ) : (
          <>
            {facePool.length > 0 && renderPool("👤 Face Pool", facePool, "face")}
            {bodyPool.length > 0 && renderPool("🏃 Body Pool", bodyPool, "body")}
          </>
        )}
      </div>
    </div>
  );
}

/* ── 主面板 ── */

export function EventsTimeline() {
  const { bus, cameraId } = useVision();
  const [events, setEvents] = useState<SeqEvent[]>([]);
  const [filterMode, setFilterMode] = useState<"all" | "active">("all");
  const [activeTrackIds, setActiveTrackIds] = useState<Set<number>>(new Set());
  /** trackKey → 该 seq 及之前的 score 项已被「清理缓存」隐藏 */
  const [clearedMarks, setClearedMarks] = useState<Record<string, number>>({});
  const [popover, setPopover] = useState<{ anchor: DOMRect; event: SeqEvent } | null>(null);
  const [clearingTrack, setClearingTrack] = useState<string | null>(null);
  const seqRef = useRef(0);
  const scoreRefs = useRef(new Map<string, HTMLSpanElement>());

  useEffect(() => {
    const offEvent = bus.on("event", (event) => {
      if (!event || !event.event_type) return;
      const seqEvent: SeqEvent = { ...event, _seq: ++seqRef.current };
      setEvents((prev) => [seqEvent, ...prev].slice(0, MAX_EVENTS));
    });
    const offResult = bus.on("frameResult", (result) => {
      const ids = new Set(
        result.tracked_persons.map((p) => p.track_id).filter((id) => id != null),
      );
      setActiveTrackIds((prev) => {
        if (prev.size === ids.size && [...prev].every((id) => ids.has(id))) return prev;
        return ids;
      });
    });
    return () => {
      offEvent();
      offResult();
    };
  }, [bus]);

  // 新事件到达后把对应卡片的 scores 容器滚到最右
  useEffect(() => {
    if (events.length === 0) return;
    const el = scoreRefs.current.get(`${events[0].track_id}`);
    if (el) el.scrollLeft = el.scrollWidth;
  }, [events]);

  const visible = filterMode === "all"
    ? events
    : events.filter((e) => e.track_id != null && activeTrackIds.has(e.track_id));

  const cards = buildCards(visible, clearedMarks);

  const handleClearCache = async (card: TrackCard) => {
    if (!cameraId || card.trackId == null) return; // 未选设备时不发请求
    setClearingTrack(card.trackKey);
    try {
      await clearQualityCache(cameraId, card.trackId);
      // 清空这一行的所有 score 数据
      setClearedMarks((prev) => ({ ...prev, [card.trackKey]: card.lastSeq }));
    } catch {
      /* ignore */
    }
    setTimeout(() => setClearingTrack(null), 800);
  };

  return (
    <section className="events-panel-root">
      <div className="panel-header">
        <h2>📋 Events</h2>
        <div className="events-tabs">
          <button
            className={`events-tab ${filterMode === "all" ? "active" : ""}`}
            onClick={() => setFilterMode("all")}
          >
            All
          </button>
          <button
            className={`events-tab ${filterMode === "active" ? "active" : ""}`}
            onClick={() => setFilterMode("active")}
          >
            Active Tracks
          </button>
        </div>
        <button className="btn btn-xs" onClick={() => setEvents([])}>Clear</button>
      </div>
      <div className="events-timeline">
        {cards.length === 0 && (
          <div className="timeline-empty">
            {filterMode === "active"
              ? "No events for active tracks."
              : "No events yet. Start the camera to begin detection."}
          </div>
        )}
        {cards.map((card) => {
          const latestStatus = card.lastEvent.message || card.lastEvent.event_type;
          const name = card.lastEvent.display_name || card.lastEvent.person_id || "";
          return (
            <div key={card.trackKey} className="event-card" data-type={card.firstEvent.event_type}>
              <span className="event-dot" />
              <span className="event-time">{formatTime(card.firstEvent.timestamp)}</span>
              <span className="event-track">
                {card.trackId != null ? `#${card.trackId}` : ""}
              </span>
              <span className={`event-status event-status--${statusClass(latestStatus)}`}>
                {statusShort(latestStatus)}
              </span>
              <span className="event-name">{name}</span>
              <span
                className="event-scores"
                ref={(el) => {
                  if (el) scoreRefs.current.set(card.trackKey, el);
                  else scoreRefs.current.delete(card.trackKey);
                }}
              >
                {card.items.map((item) => {
                  if (item.kind === "stale") {
                    return (
                      <span key={item.seq} className="event-stale-marker" title="No new data">⏸</span>
                    );
                  }
                  if (item.kind === "status") {
                    return (
                      <span
                        key={item.seq}
                        className={`event-status-inline event-status--${statusClass(item.status)}`}
                      >
                        {statusShort(item.status)}
                      </span>
                    );
                  }
                  const e = item.event;
                  const clickable = !!(e.candidates && e.candidates.length > 0);
                  return (
                    <span
                      key={item.seq}
                      className={[
                        "event-score-badge",
                        `event-score-badge--${statusClass(e.message)}`,
                        clickable ? "clickable" : "",
                      ].join(" ").trim()}
                      title="Click to view match details"
                      onClick={clickable ? (ev) => {
                        ev.stopPropagation();
                        setPopover({
                          anchor: (ev.target as HTMLElement).getBoundingClientRect(),
                          event: e,
                        });
                      } : undefined}
                    >
                      {e.fused_score != null ? e.fused_score.toFixed(2) : "—"}
                    </span>
                  );
                })}
              </span>
              {card.trackId != null && (
                <button
                  className="btn-clear-cache"
                  title="Clear quality cache"
                  disabled={clearingTrack === card.trackKey}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClearCache(card);
                  }}
                >
                  {clearingTrack === card.trackKey ? "⏳" : "🗑"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {popover && (
        <VisionPortal>
          <CandidatesPopover
            anchor={popover.anchor}
            event={popover.event}
            onClose={() => setPopover(null)}
          />
        </VisionPortal>
      )}
    </section>
  );
}
