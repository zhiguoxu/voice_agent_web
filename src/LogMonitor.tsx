import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { fetchRecentLogs, clearBackendLogs, LOGS_API_BASE, type LogEntry } from "./api";
import { StackTraceDialog } from "./StackTraceDialog";
import "./LogMonitor.css";

const LEVELS = ["TRACE", "DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR", "CRITICAL"];
const SOURCES = [
  { key: "all", label: "全部" },
  { key: "voice", label: "Voice" },
  { key: "agent", label: "Agent" },
];
const MAX_LOGS = 2000;

export function LogMonitor() {
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

  /* ── 日志缓存 ── */
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);

  /* ── 异常堆栈对话框（点击带堆栈日志行的「堆栈」按钮打开） ── */
  const [stackEntry, setStackEntry] = useState<LogEntry | null>(null);

  /* ── 滚动控制 ── */
  const listRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  /* ── 缓冲区：避免高频日志逐条 re-render ── */
  const pendingRef = useRef<LogEntry[]>([]);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el && !userScrolledUpRef.current) el.scrollTop = el.scrollHeight;
    });
  }, []);

  /* ── 首次加载历史日志 + level 变化时重新拉取 ── */
  useEffect(() => {
    let cancelled = false;
    fetchRecentLogs({ limit: 500, level })
      .then((items) => {
        if (cancelled) return;
        pendingRef.current = [];
        setLogs(items.slice(-MAX_LOGS));
        scrollToBottom();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [level, scrollToBottom]);

  /* ── SSE 实时订阅 ── */
  useEffect(() => {
    if (!live) {
      setConnected(false);
      return;
    }
    const sp = new URLSearchParams();
    if (level) sp.set("level", level);
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

    // 每 300ms 批量刷新一次
    const timer = window.setInterval(() => {
      if (pendingRef.current.length === 0) return;
      const batch = pendingRef.current;
      pendingRef.current = [];
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
  }, [live, level, scrollToBottom]);

  /* ── 滚动监听：上滚则停止自动跟随 ── */
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    userScrolledUpRef.current = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
  }, []);

  /* ── 来源 + 文本过滤，并按时间戳排序（混合视图） ── */
  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    let out = logs;
    if (source !== "all") out = out.filter((l) => (l.source || "") === source);
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
    // 时间相同则用 seq 兜底，保证稳定顺序
    return [...out].sort((a, b) => {
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      return (a.seq ?? 0) - (b.seq ?? 0);
    });
  }, [logs, search, source]);

  const clearLogs = () => {
    pendingRef.current = [];
    setLogs([]);
    // 联动清空后端内存日志缓冲，避免下次刷新/切换级别时历史日志被重新拉回
    clearBackendLogs().catch(() => {});
  };

  const jumpToBottom = () => {
    userScrolledUpRef.current = false;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="log-monitor">
      <div className="log-toolbar">
        <button
          className={`log-live-btn ${live ? "active" : ""}`}
          onClick={() => {
            const v = !live;
            setLive(v);
            localStorage.setItem("logLive", String(v));
          }}
          data-tip={live ? "暂停实时" : "开启实时"}
        >
          <span className={`log-live-dot ${live && connected ? "on" : live ? "connecting" : ""}`} />
          {live ? (connected ? "实时中" : "连接中…") : "已暂停"}
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
            placeholder="过滤：消息 / trace / SN / 文件"
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
        <button className="log-btn danger" onClick={clearLogs} data-tip="清空前端 + 后端日志缓存">
          🧹 清空
        </button>
      </div>

      <div
        className={`log-list ${wrap ? "wrap" : ""}`}
        ref={listRef}
        onScroll={handleScroll}
      >
        {filtered.length === 0 ? (
          <div className="log-empty">暂无日志</div>
        ) : (
          filtered.map((l, i) => (
            <div key={l.seq ?? `${l.time}-${i}`} className={`log-row level-${l.level}`}>
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
                  device_sn 可由工具栏「显示SN」开关控制是否展示 */}
              {showSn && (
                <>
                  <span className="log-sep">|</span>
                  <span className="log-sn">{l.device_sn}</span>
                </>
              )}
              <span className="log-sep">|</span>
              <span className="log-trace">{l.trace_id}</span>
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
