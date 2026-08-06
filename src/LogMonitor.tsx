import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { searchLogs, LOGS_API_BASE, type LogEntry } from "./api";
import { StackTraceDialog } from "./StackTraceDialog";
import { useDebounce } from "./useDebounce";
import "./LogMonitor.css";

const LEVELS = ["TRACE", "DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR", "CRITICAL"];
const SOURCES = [
  { key: "all", label: "全部" },
  { key: "voice", label: "Voice" },
  { key: "agent", label: "Agent" },
  { key: "person", label: "Person" },
];
const MAX_LOGS = 5000;
const PAGE_SIZE = 500;

/** Redis Stream 消息 ID "ms-seq" 的数值化比较（= console 到达序，全局单调）。
 *  不能整串字典序比较：seq 段不定宽，"...-9" 会被排到 "...-10" 后面。
 *  缺 uid 的条目返回 0，交给稳定排序保持原有相对位置。 */
function compareUid(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const [ams, aseq] = a.split("-");
  const [bms, bseq] = b.split("-");
  return Number(ams) - Number(bms) || Number(aseq) - Number(bseq);
}

/** 对话分析页跳转过来时预填的精确过滤条件 */
export interface LogJumpFilter {
  deviceSn?: string;
  traceId?: string;
}

export function LogMonitor({
  initialFilter,
  onInitialFilterConsumed,
}: {
  initialFilter?: LogJumpFilter;
  onInitialFilterConsumed?: () => void;
}) {
  /* ── 设置（持久化到 localStorage） ── */
  const [level, setLevel] = useState(() => localStorage.getItem("logLevel") || "INFO");
  const [source, setSource] = useState(() => localStorage.getItem("logSource") || "all");
  const [live, setLive] = useState(() => localStorage.getItem("logLive") !== "false");
  const [search, setSearch] = useState("");
  const [wrap, setWrap] = useState(() => localStorage.getItem("logWrap") === "true");
  const [showSn, setShowSn] = useState(() => localStorage.getItem("logShowSn") !== "false");
  const [showDate, setShowDate] = useState(() => localStorage.getItem("logShowDate") !== "false");
  const [locFixed, setLocFixed] = useState(() => localStorage.getItem("logLocFixed") === "true");
  const [locLen, setLocLen] = useState(() => {
    const n = parseInt(localStorage.getItem("logLocLen") || "", 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
  });

  /* ── 服务端检索条件（DB 查询 + 实时流过滤都用它们） ──
     device_sn / trace_id 完全匹配；日期范围只作用于历史检索 */
  const [deviceSn, setDeviceSn] = useState(initialFilter?.deviceSn ?? "");
  const [traceId, setTraceId] = useState(initialFilter?.traceId ?? "");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // 手输时防抖，避免每个字符都打一次 DB 查询 + SSE 重连
  const dSn = useDebounce(deviceSn.trim(), 400);
  const dTrace = useDebounce(traceId.trim(), 400);
  const startMs = useMemo(() => (startDate ? new Date(startDate).getTime() : null), [startDate]);
  const endMs = useMemo(() => (endDate ? new Date(endDate).getTime() : null), [endDate]);

  // 跳转条件是一次性的：消费掉，避免下次手动切到日志页时被重复套用
  useEffect(() => {
    onInitialFilterConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── 日志缓存 ── */
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  /** 结束时间早于当前 → 实时推流自动关闭 */
  const [streamClosed, setStreamClosed] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  /* ── 异常堆栈对话框（点击带堆栈日志行的「堆栈」按钮打开） ── */
  const [stackEntry, setStackEntry] = useState<LogEntry | null>(null);

  /* ── 滚动控制 ── */
  const listRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  /* ── 缓冲区：避免高频日志逐条 re-render ── */
  const pendingRef = useRef<LogEntry[]>([]);
  /* 已展示日志的 uid 集合：历史查询与实时流衔接处按 uid 去重 */
  const seenRef = useRef<Set<string>>(new Set());

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el && !userScrolledUpRef.current) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const serverParams = useMemo(
    () => ({
      device_sn: dSn || undefined,
      trace_id: dTrace || undefined,
      level: level || undefined,
      source: source !== "all" ? source : undefined,
      start_ms: startMs ?? undefined,
      end_ms: endMs ?? undefined,
    }),
    [dSn, dTrace, level, source, startMs, endMs]
  );

  /* ── 首屏/条件变化：按条件查 DB 历史（新→旧返回，翻转成旧→新展示） ── */
  useEffect(() => {
    let cancelled = false;
    searchLogs({ ...serverParams, limit: PAGE_SIZE })
      .then(({ items, next_cursor }) => {
        if (cancelled) return;
        const asc = [...items].reverse();
        seenRef.current = new Set(
          asc.map((e) => e.uid).filter((u): u is string => Boolean(u))
        );
        setLogs(asc);
        setNextCursor(next_cursor);
        scrollToBottom();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serverParams, scrollToBottom]);

  /* ── 向更旧翻页 ── */
  const loadOlder = useCallback(async () => {
    if (nextCursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const { items, next_cursor } = await searchLogs({
        ...serverParams,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      const asc = [...items]
        .reverse()
        .filter((e) => !e.uid || !seenRef.current.has(e.uid));
      asc.forEach((e) => e.uid && seenRef.current.add(e.uid));
      setLogs((prev) => [...asc, ...prev]);
      setNextCursor(next_cursor);
    } catch {
      /* 失败保持原状，用户可重试 */
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, serverParams]);

  /* ── SSE 实时订阅（device_sn/trace_id/source/level 服务端过滤） ── */
  useEffect(() => {
    if (!live) {
      setConnected(false);
      setStreamClosed(false);
      return;
    }
    // 结束时间早于当前 → 纯历史查询场景，自动关闭实时推流
    if (endMs != null && endMs < Date.now()) {
      setConnected(false);
      setStreamClosed(true);
      return;
    }
    setStreamClosed(false);

    const sp = new URLSearchParams();
    if (level) sp.set("level", level);
    if (dSn) sp.set("device_sn", dSn);
    if (dTrace) sp.set("trace_id", dTrace);
    if (source !== "all") sp.set("source", source);
    const es = new EventSource(`${LOGS_API_BASE}/stream?${sp}`);

    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      try {
        const entry: LogEntry = JSON.parse(e.data);
        pendingRef.current.push(entry);
      } catch {
        /* 忽略非 JSON 心跳 */
      }
    };
    es.onerror = () => setConnected(false);

    // 每 300ms 批量刷新一次；与历史查询结果按 uid 去重
    const timer = window.setInterval(() => {
      if (pendingRef.current.length === 0) return;
      const raw = pendingRef.current;
      pendingRef.current = [];
      const batch = raw.filter((e) => !e.uid || !seenRef.current.has(e.uid));
      if (batch.length === 0) return;
      batch.forEach((e) => e.uid && seenRef.current.add(e.uid));
      setLogs((prev) => {
        const next = prev.concat(batch);
        return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
      });
      scrollToBottom();
    }, 300);

    return () => {
      es.close();
      window.clearInterval(timer);
      setConnected(false);
    };
  }, [live, level, dSn, dTrace, source, endMs, scrollToBottom]);

  /* ── 滚动监听：上滚则停止自动跟随 ── */
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    userScrolledUpRef.current = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
  }, []);

  /* ── 文本部分匹配（纯前端，作用于已加载内容），并按时间戳排序 ── */
  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    let out = logs;
    if (kw) {
      out = out.filter(
        (l) =>
          l.msg.toLowerCase().includes(kw) ||
          l.trace_id.toLowerCase().includes(kw) ||
          l.device_sn.toLowerCase().includes(kw) ||
          `${l.name}:${l.function}:${l.line}`.toLowerCase().includes(kw)
      );
    }
    // 按时间戳混合排序（time 为定宽 "YYYY-MM-DD HH:mm:ss.SSS"，可直接字典序比较）；
    // 产生时刻相同（同毫秒）时按 uid 决胜——历史检索与 SSE 条目都带 uid，
    // 它是横跨两个来源的统一到达序坐标。
    return [...out].sort((a, b) => {
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      return compareUid(a.uid, b.uid);
    });
  }, [logs, search]);

  const clearLogs = () => {
    // 只清当前显示，DB 历史不动（有 90 天保留策略兜底），改条件即可重新查回
    pendingRef.current = [];
    seenRef.current = new Set();
    setLogs([]);
  };

  const clearFilters = () => {
    setDeviceSn("");
    setTraceId("");
    setStartDate("");
    setEndDate("");
  };

  const jumpToBottom = () => {
    userScrolledUpRef.current = false;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const hasFilter = deviceSn || traceId || startDate || endDate;

  return (
    <div className="log-monitor">
      <div className="log-toolbar">
        <button
          className={`log-live-btn ${live && !streamClosed ? "active" : ""}`}
          onClick={() => {
            const v = !live;
            setLive(v);
            localStorage.setItem("logLive", String(v));
          }}
          data-tip={
            streamClosed
              ? "结束时间早于当前，实时推流已自动关闭（清除结束时间可恢复）"
              : live
              ? "暂停实时"
              : "开启实时"
          }
        >
          <span
            className={`log-live-dot ${
              live && connected ? "on" : live && !streamClosed ? "connecting" : ""
            }`}
          />
          {streamClosed ? "已停实时" : live ? (connected ? "实时中" : "连接中…") : "已暂停"}
        </button>

        <label className="log-field">
          级别
          <select
            value={level}
            onChange={(e) => {
              setLevel(e.target.value);
              localStorage.setItem("logLevel", e.target.value);
            }}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>

        <div className="log-source-seg">
          {SOURCES.map((s) => (
            <button
              key={s.key}
              className={`log-seg-btn ${source === s.key ? "active" : ""}`}
              onClick={() => {
                setSource(s.key);
                localStorage.setItem("logSource", s.key);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="log-search">
          <input
            type="text"
            placeholder="文本过滤（前端，部分匹配）"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="log-search-clear" onClick={() => setSearch("")}>
              ×
            </button>
          )}
        </div>

        <label className="log-checkbox">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => {
              setWrap(e.target.checked);
              localStorage.setItem("logWrap", String(e.target.checked));
            }}
          />
          换行
        </label>

        <label className="log-checkbox">
          <input
            type="checkbox"
            checked={showSn}
            onChange={(e) => {
              setShowSn(e.target.checked);
              localStorage.setItem("logShowSn", String(e.target.checked));
            }}
          />
          显示SN
        </label>

        <label className="log-checkbox">
          <input
            type="checkbox"
            checked={showDate}
            onChange={(e) => {
              setShowDate(e.target.checked);
              localStorage.setItem("logShowDate", String(e.target.checked));
            }}
          />
          显示日期
        </label>

        <label className="log-checkbox">
          <input
            type="checkbox"
            checked={locFixed}
            onChange={(e) => {
              setLocFixed(e.target.checked);
              localStorage.setItem("logLocFixed", String(e.target.checked));
            }}
          />
          位置定长
        </label>
        {locFixed && (
          <input
            className="log-loc-len"
            type="number"
            min={4}
            max={120}
            value={locLen}
            data-tip="位置最大显示字符数，超出则截断前部、保留后部"
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              const v = Number.isFinite(n) && n > 0 ? n : 30;
              setLocLen(v);
              localStorage.setItem("logLocLen", String(v));
            }}
          />
        )}

        <span className="log-count">
          {filtered.length}
          {search && ` / ${logs.length}`} 条
        </span>

        <div className="log-toolbar-spacer" />

        <button className="log-btn" onClick={jumpToBottom} data-tip="滚到底部并恢复自动跟随">
          ↓ 底部
        </button>
        <button
          className="log-btn danger"
          onClick={clearLogs}
          data-tip="清空当前显示（数据库历史不受影响）"
        >
          🧹 清空
        </button>
      </div>

      {/* 第二行：服务端检索条件（查 DB 历史 + 实时流过滤） */}
      <div className="log-toolbar log-filter-bar">
        <label className="log-field">
          设备SN
          <span className="log-clearable">
            <input
              className="log-exact-input"
              type="text"
              placeholder="完全匹配"
              value={deviceSn}
              onChange={(e) => setDeviceSn(e.target.value)}
            />
            {deviceSn && (
              <button
                type="button"
                className="log-search-clear"
                onClick={() => setDeviceSn("")}
              >
                ×
              </button>
            )}
          </span>
        </label>
        <label className="log-field">
          Trace
          <span className="log-clearable">
            <input
              className="log-exact-input"
              type="text"
              placeholder="完全匹配"
              value={traceId}
              onChange={(e) => setTraceId(e.target.value)}
            />
            {traceId && (
              <button
                type="button"
                className="log-search-clear"
                onClick={() => setTraceId("")}
              >
                ×
              </button>
            )}
          </span>
        </label>
        <label className="log-field">
          开始
          <input
            type="datetime-local"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
        <label className="log-field">
          结束
          <input
            type="datetime-local"
            value={endDate}
            data-tip="结束时间早于当前时自动关闭实时推流"
            onChange={(e) => setEndDate(e.target.value)}
          />
        </label>
        {hasFilter && (
          <button className="log-btn" onClick={clearFilters}>
            清除条件
          </button>
        )}
        <span className="log-filter-hint">
          SN / Trace 完全匹配，与日期一起在服务端过滤；历史来自数据库（保留 90 天）
        </span>
      </div>

      <div
        className={`log-list ${wrap ? "wrap" : ""}`}
        ref={listRef}
        onScroll={handleScroll}
      >
        {nextCursor != null && (
          <div className="log-load-more-wrap">
            <button className="log-btn" disabled={loadingMore} onClick={loadOlder}>
              {loadingMore ? "加载中…" : "⇡ 加载更早"}
            </button>
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="log-empty">暂无日志</div>
        ) : (
          filtered.map((l, i) => (
            <div
              key={l.uid ?? `${l.time}-${i}`}
              className={`log-row level-${l.level}${
                i > 0 && filtered[i - 1].trace_id !== l.trace_id ? " trace-break" : ""
              }`}
            >
              {/* time 为定宽 "YYYY-MM-DD HH:mm:ss.SSS"；关闭「显示日期」时只取时间部分 */}
              <span className="log-time" data-tip={l.time}>
                {showDate ? l.time : l.time.slice(11)}
              </span>
              {l.source && (
                <span className={`log-source src-${l.source}`}>{l.source}</span>
              )}
              <span className={`log-level badge-${l.level}`}>{l.level}</span>
              {/* 位置 name:function:line；开启「位置定长」时截断前部、保留后部，前缀 …，完整值见 tip */}
              {(() => {
                const loc = `${l.name}:${l.function}:${l.line}`;
                const shown =
                  locFixed && loc.length > locLen ? "…" + loc.slice(loc.length - locLen) : loc;
                return (
                  <span
                    className={`log-loc${locFixed ? " fixed" : ""}`}
                    style={locFixed ? { width: `${locLen + 1}ch` } : undefined}
                    data-tip={loc}
                  >
                    {shown}
                  </span>
                );
              })()}
              {/* device_sn / trace_id 用竖线包裹，与控制台格式一致（即使为空也保留分隔位）；
                  device_sn 可由工具栏「显示SN」开关控制是否展示；点击即按其精确过滤 */}
              {showSn && (
                <>
                  <span className="log-sep">|</span>
                  <span
                    className={`log-sn ${l.device_sn ? "clickable" : ""}`}
                    data-tip={l.device_sn ? "点击按此设备号精确过滤" : undefined}
                    onClick={() => l.device_sn && setDeviceSn(l.device_sn)}
                  >
                    {l.device_sn}
                  </span>
                </>
              )}
              <span className="log-sep">|</span>
              <span
                className={`log-trace ${l.trace_id ? "clickable" : ""}`}
                data-tip={l.trace_id ? "点击按此 Trace ID 精确过滤" : undefined}
                onClick={() => l.trace_id && setTraceId(l.trace_id)}
              >
                {l.trace_id}
              </span>
              <span className="log-sep">|</span>
              <span className="log-msg">{l.msg}</span>
              {l.exc && (
                <button
                  className="log-exc-btn"
                  onClick={() => setStackEntry(l)}
                  data-tip="查看异常堆栈"
                >
                  堆栈
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {stackEntry && (
        <StackTraceDialog entry={stackEntry} onClose={() => setStackEntry(null)} />
      )}
    </div>
  );
}
