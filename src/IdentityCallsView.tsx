/**
 * 识别调用记录：person_id 每次 current_identity（"当前镜头前是谁"）查询一行，
 * 按设备号 / trace_id / 时间范围过滤，分页展示。数据来自 person_id
 * GET /api/identity_calls（identity_calls 表，服务端在每次调用后落库）。
 * 点行展开看调用方上下文、当时画面的抽帧（有目标时画了目标框）与服务端返回的
 * 完整 JSON；trace_id 可跳到对话分析页。
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchIdentityCalls,
  identityCallFrameUrl,
  type IdentityCallItem,
  type IdentityCallListResponse,
} from "./api";
import { TimeRangePicker, type TimeRange } from "./TimeRangePicker";
import { useDebounce } from "./useDebounce";
import "./IdentityCallsView.css";

const PAGE_SIZES = [20, 50, 100, 200];

/** CurrentIdentityResponse 里列表页要单列展示的字段（其余在展开的 JSON 里看） */
interface ParsedResponse {
  camera_online?: boolean;
  has_target?: boolean;
  display_name?: string | null;
  status?: string | null;
  fused_score?: number | null;
  track_id?: number | null;
}

function parseResponse(json: string): ParsedResponse {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as ParsedResponse) : {};
  } catch {
    return {};
  }
}

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function formatTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const RECOGNITION_LABEL: Record<string, string> = {
  known: "确信",
  suspected: "疑似",
  unknown: "未知",
};

interface Props {
  /** 点 trace_id 跳到对话分析页并定位该轮（App 提供） */
  onJumpToConversation?: (traceId: string) => void;
}

export function IdentityCallsView({ onJumpToConversation }: Props) {
  const [filterSn, setFilterSn] = useState("");
  const [filterTrace, setFilterTrace] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>(() => ({
    start: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    end: "",
  }));
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<IdentityCallListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const debouncedSn = useDebounce(filterSn.trim());
  const debouncedTrace = useDebounce(filterTrace.trim());

  // 过滤条件一变就回到第一页（否则可能停在超出新结果范围的空页）
  const changeSn = (v: string) => { setFilterSn(v); setPage(1); };
  const changeTrace = (v: string) => { setFilterTrace(v); setPage(1); };
  const changeRange = (r: TimeRange) => { setTimeRange(r); setPage(1); };
  const changePageSize = (n: number) => { setPageSize(n); setPage(1); };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchIdentityCalls({
        device_sn: debouncedSn || undefined,
        trace_id: debouncedTrace || undefined,
        start_from: timeRange.start || undefined,
        start_to: timeRange.end || undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [debouncedSn, debouncedTrace, timeRange.start, timeRange.end, pageSize, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = data?.items ?? [];

  return (
    <div className="idc-view">
      <div className="idc-toolbar">
        <div className="filter-group">
          <label>设备</label>
          <div className="input-wrap sn">
            <input
              type="text"
              placeholder="device_sn 精确匹配"
              value={filterSn}
              onChange={(e) => changeSn(e.target.value)}
            />
            {filterSn && (
              <button className="input-clear" onClick={() => changeSn("")}>×</button>
            )}
          </div>
        </div>
        <div className="filter-group">
          <label>Trace ID</label>
          <div className="input-wrap">
            <input
              type="text"
              placeholder="trace_id 精确匹配"
              value={filterTrace}
              onChange={(e) => changeTrace(e.target.value)}
            />
            {filterTrace && (
              <button className="input-clear" onClick={() => changeTrace("")}>×</button>
            )}
          </div>
        </div>
        <TimeRangePicker value={timeRange} onChange={changeRange} />
        <button className="idc-query-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "加载中…" : "刷新"}
        </button>
        <span className="idc-count">{data && `共 ${total} 次调用`}</span>
      </div>

      {error && <div className="idc-error">{error}</div>}

      <div className="idc-table-wrap">
        {!loading && items.length === 0 && !error ? (
          <div className="idc-empty">
            <div className="idc-empty-icon">👁</div>
            该条件下没有识别调用记录
          </div>
        ) : (
          <table className="idc-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>设备</th>
                <th>Trace ID</th>
                <th>来源</th>
                <th>摄像头</th>
                <th>镜头前</th>
                <th>识别</th>
                <th>person_id</th>
                <th>状态档</th>
                <th>融合分</th>
                <th>耗时</th>
                <th>抽帧</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const r = parseResponse(it.response_json);
                const expanded = expandedId === it.id;
                return (
                  <IdentityCallRow
                    key={it.id}
                    item={it}
                    parsed={r}
                    expanded={expanded}
                    onToggle={() => setExpandedId(expanded ? null : it.id)}
                    onFilterSn={() => changeSn(it.device_sn)}
                    onFilterTrace={() => changeTrace(it.trace_id)}
                    onJumpToConversation={onJumpToConversation}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="idc-pager">
        <button
          className="idc-pager-btn"
          disabled={loading || page <= 1}
          onClick={() => setPage(page - 1)}
        >
          ← 上一页
        </button>
        <span className="idc-page-info">
          第 {page} / {totalPages} 页 · 共 {total} 条
        </span>
        <button
          className="idc-pager-btn"
          disabled={loading || page >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          下一页 →
        </button>
        <label className="idc-page-size">
          每页
          <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          条
        </label>
      </div>
    </div>
  );
}

interface RowProps {
  item: IdentityCallItem;
  parsed: ParsedResponse;
  expanded: boolean;
  onToggle: () => void;
  onFilterSn: () => void;
  onFilterTrace: () => void;
  onJumpToConversation?: (traceId: string) => void;
}

function IdentityCallRow({
  item: it, parsed: r, expanded, onToggle, onFilterSn, onFilterTrace, onJumpToConversation,
}: RowProps) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <>
      <tr className={`idc-row ${expanded ? "expanded" : ""}`} onClick={onToggle}>
        <td className="idc-time">{formatTime(it.created_at)}</td>
        <td>
          <code className="idc-link" title="按此设备过滤" onClick={(e) => { stop(e); onFilterSn(); }}>
            {it.device_sn}
          </code>
        </td>
        <td>
          {it.trace_id ? (
            <span className="idc-trace" onClick={stop}>
              <code className="idc-link" title="按此 trace_id 过滤" onClick={onFilterTrace}>
                {it.trace_id}
              </code>
              {onJumpToConversation && (
                <button
                  type="button"
                  className="idc-jump"
                  title="跳到对话分析页定位该轮"
                  onClick={() => onJumpToConversation(it.trace_id)}
                >
                  对话 →
                </button>
              )}
            </span>
          ) : (
            <span className="idc-muted">—</span>
          )}
        </td>
        <td className="idc-source" title={it.source}><code>{it.source}</code></td>
        <td>
          <span className={`idc-dot ${r.camera_online ? "on" : "off"}`} />
          {r.camera_online ? "在线" : "离线"}
        </td>
        <td>{r.has_target ? "有人" : <span className="idc-muted">无人</span>}</td>
        <td>
          <span className={`idc-badge ${it.recognition}`}>
            {RECOGNITION_LABEL[it.recognition] ?? it.recognition}
          </span>
        </td>
        <td className="idc-person">
          {it.person_id ? (
            <>
              <code>{it.person_id}</code>
              {r.display_name && <span className="idc-name">{r.display_name}</span>}
            </>
          ) : (
            <span className="idc-muted">—</span>
          )}
        </td>
        <td>{r.status ?? <span className="idc-muted">—</span>}</td>
        <td className="idc-num">
          {typeof r.fused_score === "number" ? r.fused_score.toFixed(3) : <span className="idc-muted">—</span>}
        </td>
        <td className="idc-num">{it.duration_ms.toFixed(1)} ms</td>
        <td className="idc-frame-cell">
          {it.frame_cos_key ? (
            <span title="点行展开查看当时画面">📷</span>
          ) : (
            <span className="idc-muted" title={r.camera_online ? "抽帧未成功（功能关闭或上传失败）" : "摄像头离线，无画面"}>—</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="idc-detail-row">
          <td colSpan={12}>
            <div className="idc-detail">
              <div className="idc-detail-side">
                <div className="idc-meta-grid">
                  <span className="k">记录 ID</span><span className="v">#{it.id}</span>
                  <span className="k">user_id</span><span className="v mono">{it.user_id || "—"}</span>
                  <span className="k">device_type_id</span><span className="v mono">{it.device_type_id || "—"}</span>
                  <span className="k">调用方地址</span><span className="v mono">{it.client_host || "—"}</span>
                  <span className="k">track_id</span><span className="v mono">{r.track_id ?? "—"}</span>
                  <span className="k">调用时刻</span><span className="v mono">{it.created_at}</span>
                  <span className="k">抽帧</span><span className="v mono">{it.frame_cos_key || "—"}</span>
                </div>
                <pre className="idc-json">{prettyJson(it.response_json)}</pre>
              </div>
              <div className="idc-frame">
                {it.frame_cos_key ? (
                  <a href={identityCallFrameUrl(it.id)} target="_blank" rel="noreferrer" title="新窗口打开原图">
                    <img src={identityCallFrameUrl(it.id)} alt={`调用 #${it.id} 当时画面`} loading="lazy" />
                  </a>
                ) : (
                  <div className="idc-frame-empty">
                    {r.camera_online ? "该次调用没有抽帧" : "摄像头离线，没有画面"}
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
