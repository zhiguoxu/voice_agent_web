import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchSessions,
  fetchTurns,
  fetchTurnByTrace,
  deleteSession,
  clearSessionTurns,
  deleteTurn,
  replayTurn,
  testSessionInput,
  forceNewSession,
  fetchRoster,
  type Session,
  type Turn,
  type ReplayResult,
  CONVERSATIONS_API_BASE,
} from "./api";
import { useDebounce } from "./useDebounce";
import { TimeRangePicker, type TimeRange } from "./TimeRangePicker";
import { LatencyChart } from "./LatencyChart";
import { DeviceControl } from "./DeviceControl";
import { LogMonitor } from "./LogMonitor";
import { RosterView } from "./RosterView";
import { ConfigView } from "./ConfigView";
import "./App.css";

function formatTime(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN");
}

type ConfirmState = {
  message: string;
  resolve: (ok: boolean) => void;
} | null;

/** speaker_id → 展示名。名字不落库（可改名），从花名册现查；agent_server 不可达时降级为只显示裸 id。 */
function useSpeakerNames() {
  const [names, setNames] = useState<Record<string, string>>({});
  const loadingRef = useRef(false);
  const reload = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const roster = await fetchRoster();
      const map: Record<string, string> = {};
      for (const m of roster.members) {
        const n = m.name || m.aliases[0];
        if (n) map[m.person_id] = n;
      }
      setNames(map);
    } catch {
      /* 花名册拉不到只影响名字展示，不打扰主流程 */
    } finally {
      loadingRef.current = false;
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { speakerNames: names, reloadSpeakerNames: reload };
}

/** query 行右侧的说话人标识：名称 (speaker_id)；没名字只显示裸 id。
 *  与 query 同行右对齐、不收缩——query 过长时自行换行，徽章位置和空间不受挤压。
 *  名称优先用轮次里的当时快照（speaker_name，便于追溯），老数据没快照时退化为按花名册现查。 */
function SpeakerBadge({ speakerId, speakerName, names }: {
  speakerId: string | null | undefined;
  speakerName: string | null | undefined;
  names: Record<string, string>;
}) {
  if (!speakerId) return null;
  const name = speakerName || names[speakerId];
  return (
    <span className={`speaker-badge ${name ? "" : "unnamed"}`} title={`speaker_id: ${speakerId}`}>
      {name ? `${name} (${speakerId})` : speakerId}
    </span>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<"conversations" | "deviceControl" | "logs" | "roster" | "config">("conversations");
  
  /* ── 从 URL 读取初始筛选条件 ── */
  const initParams = new URLSearchParams(window.location.search);

  const [initSessionId] = useState(() => new URLSearchParams(window.location.search).get("sessionId"));
  const [initTurnId] = useState(() => new URLSearchParams(window.location.search).get("turnId"));

  /* ── Filter state ── */
  const [filterSn, setFilterSn] = useState(initParams.get("sn") ?? "");
  const [filterUser, setFilterUser] = useState(initParams.get("user") ?? "");
  const [filterTrace, setFilterTrace] = useState(initParams.get("trace") ?? "");
  const [timeRange, setTimeRange] = useState<TimeRange>({
    start: initParams.get("start") ?? "",
    end: initParams.get("end") ?? "",
  });
  const [filterOnline, setFilterOnline] = useState(() => {
    return localStorage.getItem("filterOnline") === "true";
  });

  const debouncedSn = useDebounce(filterSn);
  const debouncedUser = useDebounce(filterUser);

  /* ── Sessions state ── */
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [sessionsCursor, setSessionsCursor] = useState<number | null>(null);

  /* ── Turns state ── */
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [turnsHasMore, setTurnsHasMore] = useState(false);
  const [turnsCursor, setTurnsCursor] = useState<number | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<Turn | null>(null);

  /* ── Test Input State ── */
  const [testInputText, setTestInputText] = useState("");
  const [testInputWithTts, setTestInputWithTts] = useState(() => {
    const saved = localStorage.getItem("testInputWithTts");
    return saved ? saved === "true" : true;
  });
  const [testInputLoading, setTestInputLoading] = useState(false);

  /* ── Live Stream State ── */
  const [liveStreamEnabled, setLiveStreamEnabled] = useState(() => {
    const saved = localStorage.getItem("liveStreamEnabled");
    return saved ? saved === "true" : false;
  });
  const [realtimeTurn, setRealtimeTurn] = useState<Partial<Turn> | null>(null);
  const turnListRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  /* ── Trace lookup loading ── */
  const [traceLoading, setTraceLoading] = useState(false);

  /* ── 说话人名字映射（花名册现查） ── */
  const { speakerNames, reloadSpeakerNames } = useSpeakerNames();

  /* ── Replay modal ── */
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayInput, setReplayInput] = useState('');
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  /* ── Resize Detail Panel ── */
  const [detailWidth, setDetailWidth] = useState(() => {
    const saved = localStorage.getItem("detailWidth");
    return saved ? parseInt(saved, 10) : 340;
  });

  /* ── Custom confirm dialog ── */
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const showConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmState({ message, resolve });
    });
  }, []);
  const handleConfirmClose = (ok: boolean) => {
    if (confirmState) {
      confirmState.resolve(ok);
      setConfirmState(null);
    }
  };

  useEffect(() => {
    localStorage.setItem("detailWidth", detailWidth.toString());
  }, [detailWidth]);

  const isResizing = useRef(false);

  const startResize = useCallback((e: React.MouseEvent) => {
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = detailWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing.current) return;
      // 向左拖拽时，clientX 变小，面板宽度增加
      const deltaX = startX - moveEvent.clientX;
      const newWidth = Math.max(340, Math.min(800, startWidth + deltaX));
      setDetailWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "default";
      document.body.style.userSelect = "auto";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [detailWidth]);

  /* ── Load sessions (fresh, resets list) ── */
  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const data = await fetchSessions({
        device_sn: debouncedSn || undefined,
        user_id: debouncedUser || undefined,
        start_time: timeRange.start || undefined,
        end_time: timeRange.end || undefined,
        page_size: 20,
      });
      setSessions(data.items);
      setSessionsHasMore(data.has_more);
      setSessionsCursor(data.next_cursor);
    } finally {
      setSessionsLoading(false);
    }
  }, [debouncedSn, debouncedUser, timeRange.start, timeRange.end]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  /* ── Load more sessions (append) ── */
  const loadMoreSessions = async () => {
    if (!sessionsHasMore || sessionsCursor == null) return;
    setSessionsLoading(true);
    try {
      const data = await fetchSessions({
        device_sn: debouncedSn || undefined,
        user_id: debouncedUser || undefined,
        start_time: timeRange.start || undefined,
        end_time: timeRange.end || undefined,
        cursor: sessionsCursor,
        page_size: 20,
      });
      setSessions((prev) => [...prev, ...data.items]);
      setSessionsHasMore(data.has_more);
      setSessionsCursor(data.next_cursor);
    } finally {
      setSessionsLoading(false);
    }
  };

  /* ── 滚动到对话列表底部 ── */
  const scrollTurnsToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = turnListRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  /* ── Load turns for a session (fresh) ── */
  // API 返回最新优先（DESC），反转后按时间正序显示
  const loadTurns = useCallback(async (sessionId: number) => {
    setTurnsLoading(true);
    try {
      const data = await fetchTurns(sessionId, { page_size: 50 });
      setTurns([...data.items].reverse());
      setTurnsHasMore(data.has_more);
      setTurnsCursor(data.next_cursor);
      scrollTurnsToBottom();
      return data.items;
    } finally {
      setTurnsLoading(false);
    }
  }, [scrollTurnsToBottom]);

  /* ── Load more turns (prepend older) ── */
  const loadMoreTurns = async () => {
    if (!turnsHasMore || turnsCursor == null || !selectedSession) return;
    setTurnsLoading(true);
    try {
      const data = await fetchTurns(selectedSession.id, {
        cursor: turnsCursor,
        page_size: 50,
      });
      // API 返回更早的记录（DESC），反转后前插到列表顶部
      setTurns((prev) => [...[...data.items].reverse(), ...prev]);
      setTurnsHasMore(data.has_more);
      setTurnsCursor(data.next_cursor);
    } finally {
      setTurnsLoading(false);
    }
  };

  const handleDeleteSession = async (e: React.MouseEvent, s: Session) => {
    e.stopPropagation();
    if (s.is_online) {
      // 在线 session 不能删除，只能清除对话记录
      if (!await showConfirm("该设备当前在线，不能删除会话。\n确定要清除该会话的所有对话记录？")) return;
      try {
        await clearSessionTurns(s.id);
        // 清除后该会话已无对话，置空首末时间使按钮回到禁用态
        setSessions((prev) =>
          prev.map((x) =>
            x.id === s.id ? { ...x, first_turn_at: null, last_turn_at: null } : x
          )
        );
        if (selectedSession?.id === s.id) {
          setTurns([]);
          setSelectedTurn(null);
        }
      } catch (err: any) {
        alert(`清除失败: ${err.message}`);
      }
      return;
    }
    if (!await showConfirm("确定要删除这个会话及其所有记录吗？\n此操作不可恢复。")) return;
    try {
      await deleteSession(s.id);
      setSessions((prev) => prev.filter((x) => x.id !== s.id));
      if (selectedSession?.id === s.id) {
        setSelectedSession(null);
        setTurns([]);
        setSelectedTurn(null);
        // 清除 URL 参数
        const url = new URL(window.location.href);
        url.searchParams.delete("sessionId");
        url.searchParams.delete("turnId");
        window.history.replaceState({}, "", url);
      }
    } catch (err) {
      alert("删除失败，请重试");
    }
  };

  const handleForceNewSession = async (e: React.MouseEvent, s: Session) => {
    e.stopPropagation();
    if (!await showConfirm("确定要为该设备开启一个新 Session 吗？\n当前 Session 的对话记录会保留，后续对话将在新 Session 中进行，LLM 上下文从零开始。")) return;
    try {
      const result = await forceNewSession(s.id);
      // 刷新会话列表以显示新 session
      await loadSessions();
      // 自动选中新 session
      const newId = result.new_session_id;
      setSessions((prev) => {
        const newSession = prev.find((x) => x.id === newId);
        if (newSession) setSelectedSession(newSession);
        return prev;
      });
      setTurns([]);
      setSelectedTurn(null);
    } catch (err: any) {
      alert(`新建会话失败: ${err.message}`);
    }
  };

  /* ── Select a session ── */
  const selectSession = (s: Session) => {
    setSelectedSession(s);
    setSelectedTurn(null);
    loadTurns(s.id);
    // 顺手刷新名字映射：期间可能有人报了名字/改了名
    reloadSpeakerNames();
  };

  /* ── Trace lookup ── */
  const handleTraceLookup = async () => {
    const tid = filterTrace.trim();
    if (!tid) return;
    setTraceLoading(true);
    try {
      const result = await fetchTurnByTrace(tid);
      // Auto-select the session
      setSelectedSession(result.session);
      // Add session to list if not present
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === result.session.id);
        return exists ? prev : [result.session, ...prev];
      });
      // Load turns for the session, then select the matching turn
      const turnsData = await fetchTurns(result.session.id, { page_size: 50 });
      setTurns(turnsData.items);
      setTurnsHasMore(turnsData.has_more);
      setTurnsCursor(turnsData.next_cursor);
      setSelectedTurn(result.turn);
    } catch {
      alert("未找到该 Trace ID 对应的记录");
    } finally {
      setTraceLoading(false);
    }
  };

  /* ── SSE Live Streaming ── */
  useEffect(() => {
    let evtSource: EventSource | null = null;


    if (selectedSession?.is_online && liveStreamEnabled) {
      evtSource = new EventSource(`${CONVERSATIONS_API_BASE}/sessions/${selectedSession.id}/stream`);
      
      evtSource.onmessage = async (e) => {
        // SSE comments (: ping) won't trigger onmessage, only valid data lines
        try {
          const data = JSON.parse(e.data);
          if (data.event === "query") {
             setRealtimeTurn({ 
               id: -1, 
               query: data.text, 
               reply_text: "", 
               intent_source: null,
               intent_name: null,
               command_type: null,
               trace_id: "live-stream"
             });
          } else if (data.event === "reply_chunk") {
             setRealtimeTurn(prev => prev ? { ...prev, reply_text: (prev.reply_text || "") + data.text } : null);
          } else if (data.event === "intent") {
             setRealtimeTurn(prev => prev ? {
               ...prev,
               intent_source: data.source,
               intent_name: data.name,
               command_type: data.command,
               speaker_id: data.speaker_id ?? null,
               speaker_name: data.speaker_name ?? null,
             } : null);
           } else if (data.event === "done") {
              // done 表示 persist 已完成，DB 数据已就绪，直接拉取
              const result = await fetchTurns(selectedSession.id, { page_size: 50 });
              setTurns([...result.items].reverse());
              setTurnsHasMore(result.has_more);
              setTurnsCursor(result.next_cursor);
              setRealtimeTurn(null);
              scrollTurnsToBottom();
              // 该在线会话刚产生对话，更新列表中的首末对话时间，
              // 使「截断新建 / 清除」按钮及时从禁用变为可点
              if (result.items.length > 0) {
                const newest = result.items[0].created_at;
                const oldest = result.items[result.items.length - 1].created_at;
                setSessions((prev) =>
                  prev.map((x) =>
                    x.id === selectedSession.id
                      ? { ...x, first_turn_at: x.first_turn_at ?? oldest, last_turn_at: newest }
                      : x
                  )
                );
              }
           } else if (data.event === "error") {
              // 异常时清除实时卡片
              setRealtimeTurn(null);
              console.error("SSE error event:", data.message);
           }
        } catch (err) {
          // Ignore JSON parse errors for non-JSON messages if any
        }
      };

      evtSource.onerror = (e) => {
        // Automatically reconnects on close/error, but we might log it
        console.warn("SSE connection error", e);
      };
    }

    return () => {
      if (evtSource) {
        evtSource.close();
      }
    };
  }, [selectedSession, liveStreamEnabled, loadTurns]);

  /* ── Auto-scroll turn-list when streaming ── */
  const handleTurnListScroll = useCallback(() => {
    const el = turnListRef.current;
    if (!el) return;
    // At bottom = within 1px of the end; any scroll up disables auto-scroll
    userScrolledUpRef.current = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }, []);

  useEffect(() => {
    if (!realtimeTurn) return;
    if (userScrolledUpRef.current) return;
    const el = turnListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [realtimeTurn]);

  /* ── 筛选条件同步到 URL（不刷新页面） ── */
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedSn) params.set("sn", debouncedSn);
    if (debouncedUser) params.set("user", debouncedUser);
    if (filterTrace) params.set("trace", filterTrace);
    if (timeRange.start) params.set("start", timeRange.start);
    if (timeRange.end) params.set("end", timeRange.end);
    if (selectedSession) params.set("sessionId", selectedSession.id.toString());
    if (selectedTurn) params.set("turnId", selectedTurn.id.toString());
    
    const qs = params.toString();
    const newUrl = qs ? `?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", newUrl);
  }, [debouncedSn, debouncedUser, filterTrace, timeRange.start, timeRange.end, selectedSession, selectedTurn]);

  /* ── 刷新后恢复选中状态 ── */
  const restoredSessionRef = useRef(false);
  const restoredTurnRef = useRef(false);

  useEffect(() => {
    if (!restoredSessionRef.current && initSessionId && sessions.length > 0) {
      const s = sessions.find((s) => s.id.toString() === initSessionId);
      if (s) {
        setSelectedSession(s);
        loadTurns(s.id);
        restoredSessionRef.current = true;
      }
    }
  }, [sessions, initSessionId, loadTurns]);

  useEffect(() => {
    if (!restoredTurnRef.current && initTurnId && turns.length > 0) {
      const t = turns.find((t) => t.id.toString() === initTurnId);
      if (t) {
        setSelectedTurn(t);
        restoredTurnRef.current = true;
      }
    }
  }, [turns, initTurnId]);


  const isLoading = sessionsLoading || traceLoading;

  return (
    <div className="app">
      <header className="header">
        <h1>
          🎙️ 控制台
          <span className="app-version" title="前端版本">v{__APP_VERSION__}</span>
        </h1>
        <div className="main-tabs">
          <button 
            className={`main-tab ${activeTab === 'conversations' ? 'active' : ''}`}
            onClick={() => setActiveTab('conversations')}
          >
            对话分析
          </button>
          <button
            className={`main-tab ${activeTab === 'deviceControl' ? 'active' : ''}`}
            onClick={() => setActiveTab('deviceControl')}
          >
            设备动作下发
          </button>
          <button
            className={`main-tab ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            后端日志
          </button>
          <button
            className={`main-tab ${activeTab === 'roster' ? 'active' : ''}`}
            onClick={() => setActiveTab('roster')}
          >
            家庭花名册
          </button>
          <button
            className={`main-tab ${activeTab === 'config' ? 'active' : ''}`}
            onClick={() => setActiveTab('config')}
          >
            系统配置
          </button>
        </div>
      </header>

      {activeTab === 'conversations' ? (
        <>
          <div className="layout-outer">
            <div className="layout-left">
          {/* ── Filter Bar ── */}
          <div className="filter-bar">
        <div className="filter-group">
          <label>设备 SN</label>
          <div className="input-wrap">
            <input
              type="text"
              placeholder="精确匹配"
              value={filterSn}
              disabled={isLoading}
              onChange={(e) => setFilterSn(e.target.value)}
            />
            {filterSn && <button className="input-clear" onClick={() => setFilterSn("")}>×</button>}
          </div>
        </div>
        <div className="filter-group">
          <label>用户 ID</label>
          <div className="input-wrap">
            <input
              type="text"
              placeholder="用户 ID"
              value={filterUser}
              disabled={isLoading}
              onChange={(e) => setFilterUser(e.target.value)}
            />
            {filterUser && <button className="input-clear" onClick={() => setFilterUser("")}>×</button>}
          </div>
        </div>
        <div className="filter-group">
          <label>Trace ID</label>
          <div className="input-wrap">
            <input
              type="text"
              placeholder="回车直接查询"
              value={filterTrace}
              disabled={isLoading}
              onChange={(e) => setFilterTrace(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTraceLookup();
              }}
              onBlur={handleTraceLookup}
            />
            {filterTrace && <button className="input-clear" onClick={() => setFilterTrace("")}>×</button>}
          </div>
        </div>
        <TimeRangePicker
          value={timeRange}
          onChange={setTimeRange}
          disabled={isLoading}
        />
        <button
          className={`filter-online-btn ${filterOnline ? "active" : ""}`}
          onClick={() => {
            const val = !filterOnline;
            setFilterOnline(val);
            localStorage.setItem("filterOnline", String(val));
          }}
          title={filterOnline ? "显示全部会话" : "仅显示在线会话"}
        >
          <span className={`online-dot ${filterOnline ? "online" : ""}`} />
          在线
        </button>
        {isLoading && <div className="spinner" />}
      </div>

      <div className="layout">
        {/* 左侧：会话列表 */}
        <aside className="sidebar">
          <div className="session-list">
            {sessions.filter(s => !filterOnline || s.is_online).map((s) => (
              <div
                key={s.id}
                className={`session-card ${selectedSession?.id === s.id ? "active" : ""}`}
                onClick={() => selectSession(s)}
              >
                <div className="session-header-row">
                  <div className="session-sn">
                    <span className={`online-dot ${s.is_online ? "online" : ""}`} title={s.is_online ? "在线" : "离线"} />
                    {s.device_sn}
                  </div>
                  <div className="session-actions">
                    {s.is_online && (
                      <button
                        className="session-action-btn new-session"
                        onClick={(e) => handleForceNewSession(e, s)}
                        disabled={!s.first_turn_at}
                        title={s.first_turn_at ? "截断当前会话并新建（清空上下文）" : "当前会话暂无对话，无需新建"}
                      >
                        🔄
                      </button>
                    )}
                    <button
                      className={`session-delete-btn ${s.is_online ? "clear-only" : ""}`}
                      onClick={(e) => handleDeleteSession(e, s)}
                      disabled={s.is_online && !s.first_turn_at}
                      title={s.is_online ? (s.first_turn_at ? "清除对话记录" : "当前会话暂无对话") : "删除会话"}
                    >
                      {s.is_online ? "🧹" : "🗑️"}
                    </button>
                  </div>
                </div>
                <div className="session-meta">
                  <span>👤 {s.user_id || "-"}</span>
                  <span>📍 {s.location || "-"}</span>
                </div>
                <div className="session-time">
                  {s.first_turn_at ? (
                    <>
                      {formatTime(s.first_turn_at)}
                      {s.last_turn_at && s.last_turn_at !== s.first_turn_at && (
                        <> ~ {formatTime(s.last_turn_at)}</>
                      )}
                    </>
                  ) : (
                    formatTime(s.last_active_at)
                  )}
                </div>
              </div>
            ))}
            {sessions.length === 0 && !sessionsLoading && (
              <div className="empty">暂无会话记录</div>
            )}
            {sessionsLoading && sessions.length === 0 && (
              <div className="empty">
                <div className="spinner" />
              </div>
            )}
          </div>

          {sessionsHasMore && (
            <div className="load-more-wrap">
              <button
                className="load-more"
                disabled={sessionsLoading}
                onClick={loadMoreSessions}
              >
                {sessionsLoading ? (
                  <span className="spinner inline" />
                ) : (
                  "加载更多"
                )}
              </button>
            </div>
          )}
        </aside>

        {/* 中间：对话列表 */}
        <main className="content">
          {selectedSession ? (
            <>
              <div className="content-header">
                <h2>
                  会话 #{selectedSession.id} — {selectedSession.device_sn}
                  <span className="header-user">👤 {selectedSession.user_id || "-"}</span>
                </h2>
                <div className="content-header-actions">
                  {selectedSession.is_online && (
                    <button
                      className={`live-stream-btn ${liveStreamEnabled ? "active" : ""}`}
                      title="开启后无需刷新即可查看该在线设备的实时对话流"
                      onClick={() => {
                        const val = !liveStreamEnabled;
                        setLiveStreamEnabled(val);
                        localStorage.setItem("liveStreamEnabled", String(val));
                      }}
                    >
                      <span className={`live-dot ${liveStreamEnabled ? "active" : ""}`} />
                      实时反馈
                    </button>
                  )}

                </div>
              </div>

              <div className="turn-list" ref={turnListRef} onScroll={handleTurnListScroll}>
                {turnsHasMore && (
                  <div className="load-more-wrap">
                    <button
                      className="load-more"
                      disabled={turnsLoading}
                      onClick={loadMoreTurns}
                    >
                      {turnsLoading ? (
                        <span className="spinner inline" />
                      ) : (
                        "加载更早的记录"
                      )}
                    </button>
                  </div>
                )}
                {turns.map((t) => (
                  <div
                    key={t.id}
                    className={`turn-card ${selectedTurn?.id === t.id ? "active" : ""}`}
                    onClick={() => setSelectedTurn(t)}
                  >
                    <div className="turn-query">
                      <span className="turn-icon">👤</span>
                      <span className="turn-text">{t.query || "(无输入)"}</span>
                      <SpeakerBadge speakerId={t.speaker_id} speakerName={t.speaker_name} names={speakerNames} />
                    </div>
                    <div className="turn-reply">
                      <span className="turn-icon">🤖</span> 
                      <span className="turn-text">{t.reply_text || "(无回复)"}</span>
                    </div>
                    <div className="turn-footer">
                      {t.intent_source && (
                        <span className={`badge ${t.intent_source}`}>
                          {t.intent_source}
                        </span>
                      )}
                      {t.intent_name && (
                        <span className="badge intent">{t.intent_name}</span>
                      )}
                      {t.tool_names && (
                        <span className="badge tool">🔧 {t.tool_names}</span>
                      )}
                      <span className="trace">trace: {t.trace_id || "-"}</span>
                      <span className="turn-time">{formatTime(t.created_at)}</span>
                      <button
                        className="turn-delete-btn"
                        title="删除这条对话记录"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!await showConfirm("确定删除这条对话记录？")) return;
                          try {
                            await deleteTurn(t.id);
                            setTurns(prev => prev.filter(x => x.id !== t.id));
                            if (selectedTurn?.id === t.id) setSelectedTurn(null);
                          } catch (err: any) {
                            alert(`删除失败: ${err.message}`);
                          }
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
                {turns.length === 0 && !turnsLoading && !realtimeTurn && (
                  <div className="empty">暂无对话记录</div>
                )}
                {turnsLoading && turns.length === 0 && (
                  <div className="empty">
                    <div className="spinner" />
                  </div>
                )}
                {realtimeTurn && (
                  <div className="turn-card live-turn">
                    <div className="turn-query">
                      <span className="turn-icon">👤</span>
                      <span className="turn-text">{realtimeTurn.query || "(正在输入...)"}</span>
                      <SpeakerBadge speakerId={realtimeTurn.speaker_id} speakerName={realtimeTurn.speaker_name} names={speakerNames} />
                    </div>
                    <div className="turn-reply">
                      <span className="turn-icon">🤖</span> 
                      <span className="turn-text">{realtimeTurn.reply_text || <span className="blinking-cursor">|</span>}</span>
                    </div>
                    <div className="turn-footer">
                      {realtimeTurn.intent_source && (
                        <span className={`badge ${realtimeTurn.intent_source}`}>
                          {realtimeTurn.intent_source}
                        </span>
                      )}
                      {realtimeTurn.intent_name && (
                        <span className="badge intent">{realtimeTurn.intent_name}</span>
                      )}
                      <span className="trace live-badge">🔴 正在实时输出...</span>
                    </div>
                  </div>
                )}
              </div>

              {selectedSession.is_online && (
                <div className="test-input-panel">
                  <div className="test-input-controls">
                    <input
                      type="text"
                      className="test-input-field"
                      placeholder={realtimeTurn ? "上一轮未结束..." : "输入测试文本..."}
                      value={testInputText}
                      disabled={!!realtimeTurn}
                      onChange={(e) => setTestInputText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && testInputText.trim() && !testInputLoading && !realtimeTurn) {
                          const doSubmit = async () => {
                            // Jump to bottom and re-enable auto-scroll
                            userScrolledUpRef.current = false;
                            const el = turnListRef.current;
                            if (el) el.scrollTop = el.scrollHeight;
                            setTestInputLoading(true);
                            try {
                              await testSessionInput(selectedSession.id, testInputText.trim(), testInputWithTts);
                              setTestInputText("");
                            } catch (err: any) {
                              alert(`测试发送失败: ${err.message || String(err)}`);
                            } finally {
                              setTestInputLoading(false);
                            }
                          };
                          doSubmit();
                        }
                      }}
                    />
                    <label className="test-input-checkbox">
                      <input
                        type="checkbox"
                        checked={testInputWithTts}
                        onChange={(e) => {
                          const val = e.target.checked;
                          setTestInputWithTts(val);
                          localStorage.setItem("testInputWithTts", String(val));
                        }}
                      />
                      播放语音
                    </label>
                    <button
                      className="test-input-submit"
                      disabled={!testInputText.trim() || testInputLoading || !!realtimeTurn}
                      onClick={async () => {
                        // Jump to bottom and re-enable auto-scroll
                        userScrolledUpRef.current = false;
                        const el = turnListRef.current;
                        if (el) el.scrollTop = el.scrollHeight;
                        setTestInputLoading(true);
                        try {
                          await testSessionInput(selectedSession.id, testInputText.trim(), testInputWithTts);
                          setTestInputText("");
                        } catch (err: any) {
                          alert(`测试发送失败: ${err.message || String(err)}`);
                        } finally {
                          setTestInputLoading(false);
                        }
                      }}
                    >
                      {testInputLoading ? <span className="spinner inline" style={{width: 14, height: 14}}/> : "发送测试"}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">💬</div>
              <p>选择左侧会话查看对话记录</p>
            </div>
          )}
        </main>
        </div>
        </div>

        {/* 右侧：详情面板 */}
        {selectedTurn && (
          <div className="resize-handle" onMouseDown={startResize} />
        )}
        <aside className="detail-panel" style={selectedTurn ? { width: detailWidth, minWidth: detailWidth } : undefined}>
          {selectedTurn ? (
            <>
              <div className="detail-title-row">
                <h3>轮次详情</h3>
                {selectedTurn.trace_id && (
                  <code className="detail-trace-id" title={selectedTurn.trace_id}>
                    {selectedTurn.trace_id}
                  </code>
                )}
              </div>

              <section className="detail-section">
                <h4>📊 链路耗时可视化</h4>
                <LatencyChart turn={selectedTurn} />
              </section>

              <section className="detail-section">
                <h4>ℹ️ 元信息</h4>
                <div className="meta-grid">
                  <div className="meta-intent-row">
                    <label>说话人</label>
                    <span>
                      {selectedTurn.speaker_id ? (
                        <>
                          {(selectedTurn.speaker_name || speakerNames[selectedTurn.speaker_id]) && (
                            <b className="speaker-detail-name" title="说话时刻的名字快照">
                              {selectedTurn.speaker_name || speakerNames[selectedTurn.speaker_id]}
                            </b>
                          )}
                          <code title="person_id（身份识别服务提供）">{selectedTurn.speaker_id}</code>
                          {selectedTurn.speaker_name &&
                            speakerNames[selectedTurn.speaker_id] &&
                            speakerNames[selectedTurn.speaker_id] !== selectedTurn.speaker_name && (
                            <span className="speaker-renamed" title="花名册里的当前名字与当时不同">
                              现名: {speakerNames[selectedTurn.speaker_id]}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="speaker-unknown">未识别</span>
                      )}
                    </span>
                  </div>
                  <div className="meta-intent-row">
                    <label>意图</label>
                    <span>
                      {selectedTurn.intent_source === "llm" && selectedTurn.intent_name ? (
                        <>
                          <code title="BERT 判定意图">
                            bert: {selectedTurn.intent_name}
                            {selectedTurn.bert_confidence != null && (
                              <span className="bert-conf">{(selectedTurn.bert_confidence * 100).toFixed(1)}%</span>
                            )}
                          </code>
                          <span className="intent-arrow">›</span>
                          <code>llm</code>
                        </>
                      ) : (
                        <>
                          <code>{selectedTurn.intent_source || "-"}</code>
                          {selectedTurn.intent_name && (
                            <>
                              <span className="intent-arrow">›</span>
                              <code title="原始意图 (BERT/规则)">
                                {selectedTurn.intent_name}
                                {selectedTurn.bert_confidence != null && (
                                  <span className="bert-conf">{(selectedTurn.bert_confidence * 100).toFixed(1)}%</span>
                                )}
                              </code>
                            </>
                          )}
                        </>
                      )}

                      {selectedTurn.command_type && selectedTurn.command_type !== selectedTurn.intent_name && (
                        <>
                          <span className="intent-arrow">›</span>
                          <code title="最终执行指令">{selectedTurn.command_type}</code>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              </section>

              {selectedTurn.chat_request && (
                <section className="detail-section">
                  <h4>🔁 对话复现</h4>
                  <button
                    className="chat-request-btn replay-btn-primary"
                    onClick={() => {
                      const cr = selectedTurn.chat_request;
                      const replayData = {
                        ...cr,
                        device_sn: selectedSession?.device_sn ?? "",
                        user_id: selectedSession?.user_id ?? "",
                        device_type_id: selectedSession?.device_type_id ?? "2",
                        session_id: selectedSession?.id ?? 0,
                        location: selectedSession?.location ?? null,
                        image_url: cr?.image_url ?? null,
                      };
                      setReplayInput(JSON.stringify(replayData, null, 2));
                      setReplayResult(null);
                      setReplayError(null);
                      setReplayOpen(true);
                    }}
                  >
                    📋 查看输入 / 复现
                  </button>
                </section>
              )}

              <section className="detail-section">
                <h4>📎 媒体附件</h4>
                <div className="media-attachments">
                  {selectedTurn.image_cos_key && (
                    <div className="media-item">
                      <div className="media-header">
                        <label>输入图片</label>
                        <a className="media-download" href={`${CONVERSATIONS_API_BASE}/media?key=${encodeURIComponent(selectedTurn.image_cos_key)}&download=true&filename=${encodeURIComponent(`image_${selectedTurn.trace_id}.${selectedTurn.image_cos_key.split('.').pop()}`)}`} download>下载附件</a>
                      </div>
                      <img
                        src={`${CONVERSATIONS_API_BASE}/media?key=${encodeURIComponent(selectedTurn.image_cos_key)}`}
                        alt="Input"
                        className="media-image"
                      />
                    </div>
                  )}
                  {selectedTurn.input_audio_cos_key && (
                    <div className="media-item">
                      <div className="media-header">
                        <label>输入语音</label>
                        <a className="media-download" href={`${CONVERSATIONS_API_BASE}/media?key=${encodeURIComponent(selectedTurn.input_audio_cos_key)}&download=true&filename=${encodeURIComponent(`asr_${selectedTurn.trace_id}.${selectedTurn.input_audio_cos_key.split('.').pop()}`)}`} download>下载附件</a>
                      </div>
                      <audio
                        controls
                        src={`${CONVERSATIONS_API_BASE}/media?key=${encodeURIComponent(selectedTurn.input_audio_cos_key)}`}
                        className="media-audio"
                      />
                    </div>
                  )}
                  {selectedTurn.tts_audio_cos_key && (
                    <div className="media-item">
                      <div className="media-header">
                        <label>TTS 回复语音</label>
                        <a className="media-download" href={`${CONVERSATIONS_API_BASE}/media?key=${encodeURIComponent(selectedTurn.tts_audio_cos_key)}&download=true&filename=${encodeURIComponent(`tts_${selectedTurn.trace_id}.${selectedTurn.tts_audio_cos_key.split('.').pop()}`)}`} download>下载附件</a>
                      </div>
                      <audio
                        controls
                        src={`${CONVERSATIONS_API_BASE}/media?key=${encodeURIComponent(selectedTurn.tts_audio_cos_key)}`}
                        className="media-audio"
                      />
                    </div>
                  )}
                  {!selectedTurn.image_cos_key && !selectedTurn.input_audio_cos_key && !selectedTurn.tts_audio_cos_key && (
                    <div className="empty-media">无媒体文件</div>
                  )}
                </div>
              </section>
            </>
          ) : (
            <div className="empty-state small">
              <p>点击对话查看详情</p>
            </div>
          )}
        </aside>
      </div>

      {replayOpen && (
        <div className="latency-modal-overlay" onClick={() => setReplayOpen(false)}>
          <div className="replay-modal" onClick={e => e.stopPropagation()}>
            <div className="latency-modal-header">
              <h3>🔁 查看输入/复现</h3>
              <button className="latency-modal-close" onClick={() => setReplayOpen(false)}>×</button>
            </div>
            <div className="replay-body">
              <div className="replay-input-panel">
                <label>请求参数 (ChatRequest JSON)</label>
                <textarea
                  className="replay-textarea"
                  value={replayInput}
                  onChange={e => setReplayInput(e.target.value)}
                  spellCheck={false}
                />
                <button
                  className="replay-run-btn"
                  disabled={replayLoading}
                  onClick={async () => {
                    setReplayLoading(true);
                    setReplayError(null);
                    setReplayResult(null);
                    try {
                      const parsed = JSON.parse(replayInput);
                      const result = await replayTurn(parsed);
                      setReplayResult(result);
                    } catch (e: any) {
                      setReplayError(e.message || String(e));
                    } finally {
                      setReplayLoading(false);
                    }
                  }}
                >
                  {replayLoading ? '复现中...' : '▶ 执行复现'}
                </button>
              </div>
              <div className="replay-result-panel">
                {replayError && <div className="replay-error">❌ {replayError}</div>}
                {replayResult && (
                  <>
                    <div className="replay-meta">
                      <span>意图来源: <b>{replayResult.intent_source || '-'}</b></span>
                      {replayResult.intent_name && <span>意图名: <b>{replayResult.intent_name}</b></span>}
                      {replayResult.command_type && <span>指令: <b>{replayResult.command_type}</b></span>}
                    </div>
                    <div className="replay-reply">
                      <label>回复文本</label>
                      <div className="replay-reply-text">{replayResult.reply_text || '(无文本回复)'}</div>
                    </div>
                    <section className="detail-section">
                      <h4>📊 链路耗时可视化</h4>
                      <LatencyChart turn={{
                        ...({} as Turn),
                        ...replayResult.timing,
                        t_tts_first_audio: null,
                      }} />
                    </section>
                  </>
                )}
                {!replayResult && !replayError && (
                  <div className="replay-placeholder">修改左侧参数后点击「执行复现」</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      </>
      ) : activeTab === 'deviceControl' ? (
        <DeviceControl sessions={sessions} />
      ) : activeTab === 'roster' ? (
        <RosterView />
      ) : activeTab === 'config' ? (
        <ConfigView />
      ) : (
        <LogMonitor />
      )}
      {/* Custom Confirm Dialog */}
      {confirmState && (
        <div className="confirm-overlay" onClick={() => handleConfirmClose(false)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="confirm-icon">🗑</div>
            <p className="confirm-message">{confirmState.message}</p>
            <div className="confirm-actions">
              <button className="confirm-btn cancel" onClick={() => handleConfirmClose(false)}>取消</button>
              <button className="confirm-btn danger" onClick={() => handleConfirmClose(true)}>确认删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
