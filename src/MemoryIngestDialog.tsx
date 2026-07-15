import { useState, useEffect, useCallback } from "react";
import { fetchMemoryIngestRuns, type MemoryIngestRun, type IngestTurn } from "./api";
import "./MemoryDialog.css";
import "./MemoryIngestDialog.css";

const PAGE_SIZE = 20;

/* 触发原因（取值见 family_memory.models.MemoryIngestRunORM 注释） */
const TRIGGER_LABELS: Record<string, string> = {
  batch_full: "攒满批",
  idle_timeout: "静默超时",
  session_switch: "切换会话",
  shutdown: "停机收尾",
};

const STATUS_LABELS: Record<string, string> = {
  ok: "成功",
  empty: "无草稿",
  error: "失败",
};

/* apply_drafts 统计字段的中文名 */
const STAT_LABELS: Record<string, string> = {
  added: "新增",
  replaced: "替换",
  removed: "撤回",
  skipped: "去重跳过",
  extremum_set: "极值设置",
  extremum_cleared: "极值清除",
};

function formatTime(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN");
}

/** 写入统计摘要（只列非零项，如「新增 2 · 替换 1」） */
function statsSummary(stats: Record<string, number> | null): string {
  if (!stats) return "";
  const parts = Object.entries(stats)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${STAT_LABELS[k] || k} ${v}`);
  return parts.join(" · ");
}

function TurnList({ turns, muted, highlightTrace }: {
  turns: IngestTurn[]; muted?: boolean; highlightTrace?: string;
}) {
  if (turns.length === 0) return <div className="empty">（无）</div>;
  return (
    <div className={`ingest-turns ${muted ? "muted" : ""}`}>
      {turns.map((t) => (
        <div
          key={t.turn_id}
          className={`ingest-turn ${t.is_robot ? "robot" : ""} ${
            highlightTrace && t.trace_id === highlightTrace ? "hit" : ""}`}
          data-tip={t.trace_id ? `trace: ${t.trace_id}` : undefined}
        >
          <code className="ingest-turn-id">{t.turn_id}</code>
          <span className="ingest-turn-speaker">{t.speaker}</span>
          <span className="ingest-turn-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** 单次运行的过程回放：输入轮次 → LLM 原始输出 → 护栏后草稿 → 写入统计 */
function RunDetail({ run, highlightTrace }: { run: MemoryIngestRun; highlightTrace?: string }) {
  return (
    <div className="ingest-run-detail">
      {run.error && <div className="roster-error">❌ {run.error}</div>}

      {run.context_turns.length > 0 && (
        <details className="ingest-section">
          <summary>上文（只读，供指代消解，{run.context_turns.length} 轮）</summary>
          <TurnList turns={run.context_turns} muted highlightTrace={highlightTrace} />
        </details>
      )}

      <div className="ingest-section-title">新对话（抽取源，{run.new_turns.length} 轮）</div>
      <TurnList turns={run.new_turns} highlightTrace={highlightTrace} />

      {run.llm_raw && (
        <details className="ingest-section">
          <summary>LLM 原始输出（模型给出 {run.model_count} 条，护栏后 {run.draft_count} 条）</summary>
          <pre className="ingest-llm-raw">{run.llm_raw}</pre>
        </details>
      )}

      <div className="ingest-section-title">
        抽取草稿（{run.drafts.length} 条{run.drafts.length > 1 ? "，本批一起抽取" : ""}）
      </div>
      {run.drafts.length > 0 ? (
        <div className="ingest-drafts">
          {run.drafts.map((d, i) => (
            <div key={i} className="memory-item">
              <span className="memory-item-subjects">
                {d.subjects.map((s) => s.name).join("、") || "-"}
              </span>
              {d.tag && (
                <span className="memory-item-value">
                  <code className="memory-key-path">{d.tag.key}</code> = {d.tag.value}
                  {d.tag.is_extremum && <span className="memory-badge extremum">最X</span>}
                  {d.tag.negate && <span className="memory-badge superseded-tag">撤回</span>}
                </span>
              )}
              <span className="memory-item-content" data-tip={d.content_raw}>{d.content}</span>
              {d.mem_type === "household" && <span className="memory-badge household">全家</span>}
              {d.from_turn != null && (
                <span className="memory-item-time">来源 {String(d.from_turn)}</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">本批无值得长期记的内容（或抽取失败）</div>
      )}

      {run.stats && (
        <div className="ingest-section-title">
          写入统计：{statsSummary(run.stats) || "全部跳过"}
          <span className="ingest-timing">
            抽取 {run.extract_ms}ms · 写入 {run.apply_ms}ms
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 抽取记录对话框：按设备所属家庭展示记忆抽取/应用运行日志，最新在前、分页。
 * 两个入口：
 * - 会话标题行「📋 抽取记录」按钮：全家庭运行列表（分页）；
 * - 轮次行「📋 已抽取」按钮（traceId 给定）：只显示抽取源包含该轮的运行，
 *   高亮该轮，不分页——该轮可能与同批其他轮次一起抽取，一并展示。
 * 一行 = 一次批处理运行；点开可回放该批完整过程（输入轮次、LLM 输出、
 * 一起抽取的全部草稿、写入统计与触发原因）。
 */
export function MemoryIngestDialog({ deviceSn, sessionId, traceId, onClose }: {
  deviceSn: string;
  sessionId?: number;
  traceId?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchMemoryIngestRuns>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchMemoryIngestRuns(deviceSn, page, PAGE_SIZE,
                                          { sessionId, traceId }));
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [deviceSn, sessionId, traceId, page]);

  useEffect(() => {
    load();
  }, [load]);

  /* Esc 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="roster-dialog-overlay" onClick={onClose}>
      <div className="roster-dialog memory-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>
          📋 抽取记录
          <span className="subtitle">
            {traceId
              ? `该轮对话所在的抽取批次（trace ${traceId}）· 高亮为本轮，同批其他轮次一并展示`
              : `设备 ${deviceSn} 所属家庭 · 记忆抽取/应用运行日志，最新在前`}
          </span>
          <button className="roster-refresh" onClick={load} disabled={loading}>
            {loading ? <span className="spinner inline" /> : "🔄 刷新"}
          </button>
          <button className="roster-close" onClick={onClose} data-tip="关闭 (Esc)">×</button>
        </h3>

        <div className="roster-dialog-body">
          {error && <div className="roster-error">❌ {error}</div>}

          {data && !data.enabled && (
            <div className="roster-disabled">
              记忆系统未启用（memory.enabled=false），无抽取记录。
            </div>
          )}

          {data?.enabled && (
            data.items.length > 0 ? (
              <>
                <div className="ingest-runs">
                  {data.items.map((run) => (
                    <details key={run.id} className="memory-key-node ingest-run"
                             open={!!traceId}>
                      <summary>
                        <span className="memory-key-name">#{run.id}</span>
                        <span className={`memory-badge ingest-status-${run.status}`}>
                          {STATUS_LABELS[run.status] || run.status}
                        </span>
                        <span className="memory-badge ingest-trigger">
                          {TRIGGER_LABELS[run.trigger] || run.trigger}
                        </span>
                        <span className="ingest-summary-text">
                          {run.new_turns.length} 轮 → {run.draft_count} 条草稿
                          {run.stats ? ` · ${statsSummary(run.stats) || "全部跳过"}` : ""}
                        </span>
                        <span className="memory-item-time" data-tip={`会话 #${run.session_id}`}>
                          {formatTime(run.created_at)}
                        </span>
                      </summary>
                      <div className="memory-key-body">
                        <RunDetail run={run} highlightTrace={traceId} />
                      </div>
                    </details>
                  ))}
                </div>
                {!traceId && (
                  <div className="memory-pagination">
                    <button className="roster-cancel-btn" disabled={loading || page <= 1}
                            onClick={() => setPage(page - 1)}>
                      ← 上一页
                    </button>
                    <span className="memory-page-info">
                      第 {data.page} / {totalPages} 页 · 共 {data.total} 次运行
                    </span>
                    <button className="roster-cancel-btn" disabled={loading || page >= totalPages}
                            onClick={() => setPage(page + 1)}>
                      下一页 →
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="empty">
                {traceId
                  ? "未找到该轮对应的抽取记录（可能还在缓冲中未触发抽取，或为旧数据未记录 trace）"
                  : "该家庭暂无抽取记录（对话攒满批或静默超时后才触发抽取）"}
              </div>
            )
          )}

          {loading && !data && (
            <div className="empty"><div className="spinner" /></div>
          )}
        </div>
      </div>
    </div>
  );
}
