/**
 * 算法流水线调试面板（从 person_id/frontend/js/pipeline-panel.js 移植）。
 *
 * 显示 Detection → Face Detect → Face Assess → ReID 各阶段的
 * 状态、耗时、缩略图与结果摘要。数据随每帧 frame_result 更新。
 */
import { useEffect, useRef, useState } from "react";
import { useVision } from "./context";
import type { PipelineDebug, PipelineStageData, PipelineStageName } from "./types";

const STAGES: Array<{ key: PipelineStageName; icon: string; name: string }> = [
  { key: "detection", icon: "🎯", name: "Detection" },
  { key: "face_detect", icon: "👤", name: "Face Detect" },
  { key: "face_assess", icon: "💎", name: "Face Assess" },
  { key: "reid", icon: "🏃", name: "ReID" },
];

function statusIcon(status: string): string {
  switch (status) {
    case "done": return "✅";
    case "running": return "⏳";
    case "skipped": return "⏭️";
    case "error": return "❌";
    default: return "—";
  }
}

function StageDetails({ stage, data }: { stage: PipelineStageName; data: PipelineStageData }) {
  const { openLightbox } = useVision();
  const details = data.details || {};

  switch (stage) {
    case "detection": {
      const count = details.count || 0;
      return (
        <>
          <div className="detail-line">{count} person(s) detected</div>
          {details.thumbnails_base64 && (
            <div className="detail-thumbnails">
              {details.thumbnails_base64.map((thumb, i) => (
                <img
                  key={i}
                  src={`data:image/jpeg;base64,${thumb}`}
                  className="detail-thumb"
                  alt={`Person ${i}`}
                  onClick={() => openLightbox(`data:image/jpeg;base64,${thumb}`)}
                />
              ))}
            </div>
          )}
        </>
      );
    }
    case "face_detect": {
      const total = details.total || 0;
      if (total === 0) return null;
      return <div className="detail-line">{details.detected || 0}/{total} faces detected (SCRFD)</div>;
    }
    case "face_assess": {
      const results = details.results || [];
      if (results.length === 0) return null;
      return (
        <>
          {results.map((r, i) => {
            const quality = r.quality != null ? r.quality.toFixed(2) : "N/A";
            const icon = r.extracted ? ((r.quality ?? 0) > 0.7 ? "✅" : "⚠️") : "❌";
            return (
              <div key={i} className="detail-line">
                Track #{r.track_id}: {icon} quality={quality}
              </div>
            );
          })}
        </>
      );
    }
    case "reid": {
      const results = details.results || [];
      if (results.length === 0) return null;
      return (
        <>
          {results.map((r, i) => (
            <div key={i} className="detail-line">
              Track #{r.track_id}: {r.feature_dim || 2048}-d extracted
            </div>
          ))}
        </>
      );
    }
  }
}

export function PipelinePanel() {
  const { bus } = useVision();
  const [debug, setDebug] = useState<PipelineDebug>({});
  const [expanded, setExpanded] = useState<Set<PipelineStageName>>(new Set());
  // pending/skipped 时显示上次的时长 (变灰)
  const lastTimeMsRef = useRef<Partial<Record<PipelineStageName, number>>>({});

  useEffect(() => {
    return bus.on("frameResult", (result) => {
      if (result.pipeline_debug) setDebug(result.pipeline_debug);
    });
  }, [bus]);

  let totalMs = 0;
  const stageViews = STAGES.map(({ key, icon, name }) => {
    const data = debug[key] || {};
    const status = data.status || "pending";

    let timeText = "—";
    let stale = false;
    if (data.time_ms !== undefined && data.time_ms > 0) {
      timeText = `${data.time_ms.toFixed(1)}ms`;
      totalMs += data.time_ms;
      lastTimeMsRef.current[key] = data.time_ms;
    } else if ((lastTimeMsRef.current[key] ?? 0) > 0) {
      timeText = `${lastTimeMsRef.current[key]!.toFixed(1)}ms`;
      stale = true;
    }

    return { key, icon, name, data, status, timeText, stale };
  });

  const toggleExpand = (key: PipelineStageName) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className="side-panel pipeline-panel-root">
      <div className="panel-header">
        <h2>⚡ Pipeline Debug</h2>
        <span className="badge">{totalMs.toFixed(1)}ms</span>
      </div>
      <div className="pipeline-stages">
        {stageViews.map((s, i) => (
          <div key={s.key}>
            {i > 0 && <div className="pipeline-connector">↓</div>}
            <div
              className={[
                "pipeline-stage",
                s.status === "running" ? "active" : "",
                expanded.has(s.key) ? "expanded" : "",
              ].join(" ").trim()}
            >
              <div className="stage-header" onClick={() => toggleExpand(s.key)}>
                <span className="stage-icon">{s.icon}</span>
                <span className="stage-name">{s.name}</span>
                <span className={`stage-status ${s.status}`}>{statusIcon(s.status)}</span>
                <span className={`stage-time ${s.stale ? "stale" : ""}`}>{s.timeText}</span>
              </div>
              <div className="stage-details">
                <StageDetails stage={s.key} data={s.data} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
