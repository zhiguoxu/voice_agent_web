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
  updateDeviceName,
  fetchRoster,
  fetchExtractedTraces,
  type Session,
  type Turn,
  type IdentityDebug,
  type ReplayResult,
  CONVERSATIONS_API_BASE,
} from "./api";
import IdentityDebugDialog from "./IdentityDebugDialog";
import { useDebounce } from "./useDebounce";
import { TimeRangePicker, type TimeRange } from "./TimeRangePicker";
import { LatencyChart } from "./LatencyChart";
import { DeviceControl } from "./DeviceControl";
import { LogMonitor } from "./LogMonitor";
import { RosterDialog } from "./RosterDialog";
import { MemoryDialog } from "./MemoryDialog";
import { MemoryIngestDialog } from "./MemoryIngestDialog";
import { FaceRegisterDialog } from "./FaceRegisterDialog";
import { MemoryRecallPanel } from "./MemoryRecallPanel";
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

/** speaker_id → 展示名。名字不落库（可改名），从当前会话设备所属家庭的花名册现查
 *  （多家庭同库，按 device_sn 取本家）；agent_server 不可达时降级为只显示裸 id。 */
function useSpeakerNames(deviceSn: string | null | undefined) {
  const [names, setNames] = useState<Record<string, string>>({});
  const loadingRef = useRef(false);
  const reload = useCallback(async () => {
    if (!deviceSn) {
      setNames({});
      return;
    }
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const roster = await fetchRoster(deviceSn);
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
  }, [deviceSn]);
  useEffect(() => { reload(); }, [reload]);
  return { speakerNames: names, reloadSpeakerNames: reload };
}

/** query 行右侧的说话人标识：名称 (speaker_id)；没名字只显示裸 id。
 *  与 query 同行右对齐、不收缩——query 过长时自行换行，徽章位置和空间不受挤压。
 *  名称优先用轮次里的当时快照（speaker_name，便于追溯），老数据没快照时退化为按花名册现查。
 *  冲突/疑似轮加对应记号（该轮归属存疑）；轮次带 identity_debug 时标签可点击，
 *  弹窗展示该轮身份融合过程（视觉/声纹分数与判定、融合结论）。 */
function SpeakerBadge({ speakerId, speakerName, kind, suspected, debug, names, onShowDebug }: {
  speakerId: string | null | undefined;
  speakerName: string | null | undefined;
  kind: string | null | undefined;       /* 落库的 speaker_conflict_kind（仲裁走向） */
  suspected: boolean | null | undefined;
  debug: IdentityDebug | null | undefined;
  names: Record<string, string>;
  onShowDebug: (payload: { debug: IdentityDebug; conflict: boolean; suspected: boolean }) => void;
}) {
  /* 没识别出人但有融合过程记录时也要能点开看"为什么没认出"，所以不能只看 speakerId */
  if (!speakerId && !debug) return null;
  const name = speakerId ? (speakerName || names[speakerId]) : null;
  const text = speakerId ? (name ? `${name} (${speakerId})` : speakerId) : "未识别";
  /* 仲裁走向统一从 speaker_conflict_kind 取（历史形态——speaker_conflict 布尔
     旗标、字段名 kind、枚举值 mark——存量均已由 session_store 启动补丁订正,
     这里不留旧名分支）；该列早于列诞生的行退化读融合记录 */
  const effKind = kind ?? debug?.fusion?.conflict_kind ?? null;
  const source = debug?.fusion?.source ?? null;
  const isConflict = effKind === "voice_doubt";
  const marks: string[] = [];
  let markTip = "";
  if (isConflict) {
    marks.push("冲突");
    markTip = "看清了镜头里的人，但这句话的声音没听准——归他但存疑，这句不写进他的记忆";
  } else if (suspected) {
    if (effKind === "voice_override") {
      marks.push("疑似·声纹改判");
      markTip = "镜头里看到的是别人，这句话的声纹强指向此人，按疑似档归属给他";
    } else if (source === "voice") {
      marks.push("疑似·凭声音");
      markTip = "镜头里没认出人，凭这句话的声音像他归属";
    } else if (source === "vision") {
      marks.push("疑似·没看清");
      markTip = "没看清人（视觉置信只到疑似档），按最像的人归属";
    } else {
      marks.push("疑似");
      markTip = "归属存疑";
    }
  }
  const tip = [markTip, debug
    ? `speaker_id: ${speakerId ?? "无"}；点击查看本轮身份融合过程`
    : `speaker_id: ${speakerId}`].filter(Boolean).join("。");
  return (
    <span
      className={[
        "speaker-badge",
        name ? "" : "unnamed",
        isConflict ? "conflict" : "",
        suspected ? "suspected" : "",
        debug ? "clickable" : "",
      ].join(" ").replace(/\s+/g, " ").trim()}
      data-tip={tip}
      onClick={debug ? (e) => {
        e.stopPropagation();  // 别触发轮次卡片的选中
        onShowDebug({ debug, conflict: isConflict, suspected: !!suspected });
      } : undefined}
    >
      {marks.length > 0 && <b className="speaker-mark">{marks.join("·")}</b>}
      {text}
    </span>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<"conversations" | "deviceControl" | "logs" | "config">("conversations");
  /* 家庭花名册对话框：按会话设备打开（多家庭同库，只看该设备所属家庭） */
  const [rosterDeviceSn, setRosterDeviceSn] = useState<string | null>(null);
  /* 记忆查询对话框：同上按设备所属家庭（B 类 key 树 + A 类分页表） */
  const [memoryDeviceSn, setMemoryDeviceSn] = useState<string | null>(null);
  /* 抽取记录对话框：记忆抽取/应用运行日志（每次批处理一行，含触发原因与过程回放）。
     traceId 给定时是轮次行入口（只看该轮所在批次），否则是全家庭列表入口 */
  const [ingestDialog, setIngestDialog] = useState<
    { deviceSn: string; sessionId?: number; traceId?: string } | null>(null);
  /* 注册人脸对话框：输入人名后触发该设备的引导式人脸注册（结果以设备播报为准） */
  const [faceRegDeviceSn, setFaceRegDeviceSn] = useState<string | null>(null);
  /* 当前会话中已进入过抽取批次的轮次 trace 集合（轮次行「已抽取/未抽取」标记）。
     记忆系统未启用时为 null，轮次行不显示任何抽取标记 */
  const [extractedTraces, setExtractedTraces] = useState<Set<string> | null>(null);
  
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
  /* 身份融合调试弹窗（点轮次卡片的说话人标签打开） */
  const [identityDebugShown, setIdentityDebugShown] = useState<{
    debug: IdentityDebug; conflict: boolean; suspected: boolean;
  } | null>(null);

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
  // 实时卡片列表：通常只有一张（当前轮）；打断场景下被打断轮的卡片以
  // finalizing=true 降级为"等待保存"留在原地，等它的 done 触发列表刷新后
  // 再移除——避免半截回复在落库完成前从页面上消失
  type LiveTurn = Partial<Turn> & { finalizing?: boolean };
  const [liveTurns, setLiveTurns] = useState<LiveTurn[]>([]);
  // 是否有正在流式输出的轮次（不含等待保存的），决定发送按钮的打断语义提示
  const liveStreaming = liveTurns.some(t => !t.finalizing);
  const turnListRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  // done 事件的列表刷新串行链：打断场景下多个轮次的 done 会先后到达，
  // 各自的 fetchTurns 若并发，晚发出的请求先返回时会被早请求的旧快照
  // 覆盖（刚落库的轮次从列表里消失）。串行保证快照只变新不回退
  const doneRefreshChainRef = useRef<Promise<void>>(Promise.resolve());

  /* ── Trace lookup loading ── */
  const [traceLoading, setTraceLoading] = useState(false);

  /* ── 说话人名字映射（按当前会话设备的家庭花名册现查） ── */
  const { speakerNames, reloadSpeakerNames } = useSpeakerNames(selectedSession?.device_sn);

  /* ── Replay modal ── */
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayInput, setReplayInput] = useState('');
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  /* ── Resize Detail Panel ── */
  const [detailWidth, setDetailWidth] = useState(() => {
    const saved = localStorage.getItem("detailWidth");
    return saved ? Math.max(parseInt(saved, 10), 380) : 380;
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
      const newWidth = Math.max(380, Math.min(800, startWidth + deltaX));
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

  /* 会话查询序号：筛选框在加载中不锁输入，连续输入会并发多个查询，
     只认最新序号的响应，过期的直接丢弃 */
  const sessionsReqSeq = useRef(0);

  /* ── Load sessions (fresh, resets list) ── */
  const loadSessions = useCallback(async () => {
    const seq = ++sessionsReqSeq.current;
    setSessionsLoading(true);
    try {
      const data = await fetchSessions({
        device_sn: debouncedSn || undefined,
        user_id: debouncedUser || undefined,
        start_time: timeRange.start || undefined,
        end_time: timeRange.end || undefined,
        page_size: 20,
      });
      if (seq !== sessionsReqSeq.current) return;
      setSessions(data.items);
      setSessionsHasMore(data.has_more);
      setSessionsCursor(data.next_cursor);
    } finally {
      if (seq === sessionsReqSeq.current) setSessionsLoading(false);
    }
  }, [debouncedSn, debouncedUser, timeRange.start, timeRange.end]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  /* ── Load more sessions (append) ── */
  const loadMoreSessions = async () => {
    if (!sessionsHasMore || sessionsCursor == null) return;
    const seq = ++sessionsReqSeq.current;
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
      // 翻页期间筛选条件变了会触发新查询，本次追加已过期，丢弃
      if (seq !== sessionsReqSeq.current) return;
      setSessions((prev) => [...prev, ...data.items]);
      setSessionsHasMore(data.has_more);
      setSessionsCursor(data.next_cursor);
    } finally {
      if (seq === sessionsReqSeq.current) setSessionsLoading(false);
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

  /* ── 当前会话的「已抽取」trace 集合 ──
     随选中会话变化拉取；轮次重新加载（刷新按钮/实时流落库）时也会因
     loadTurns 触发的重渲染在下次切会话时更新，这里额外跟随 turns 长度刷新，
     让「静默超时抽取完成后手动刷新轮次」能看到标记变化。失败静默（调试辅助
     信息，不打扰主流程）。 */
  useEffect(() => {
    if (!selectedSession) {
      setExtractedTraces(null);
      return;
    }
    let stale = false;
    fetchExtractedTraces(selectedSession.device_sn, selectedSession.id)
      .then((d) => {
        if (!stale) setExtractedTraces(d.enabled ? new Set(d.trace_ids) : null);
      })
      .catch(() => { if (!stale) setExtractedTraces(null); });
    return () => { stale = true; };
  }, [selectedSession, turns.length]);

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

  /* ── 设备显示名称：名称挂在设备档案上，同设备的所有会话一起更新 ── */
  const handleRenameDevice = async (e: React.MouseEvent, s: Session) => {
    e.stopPropagation();
    const input = window.prompt(
      `设备 ${s.device_sn} 的显示名称（留空清除）：`,
      s.device_name ?? ""
    );
    if (input === null) return; // 取消
    const name = input.trim();
    try {
      await updateDeviceName(s.device_sn, name);
      setSessions((prev) =>
        prev.map((x) =>
          x.device_sn === s.device_sn ? { ...x, device_name: name || null } : x
        )
      );
      setSelectedSession((prev) =>
        prev && prev.device_sn === s.device_sn
          ? { ...prev, device_name: name || null }
          : prev
      );
    } catch (err: any) {
      alert(`设置设备名称失败: ${err.message}`);
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
          // 打断场景下两轮的事件会交错到达（新轮 query 之后仍可能收到旧轮的
          // reply_chunk/done），一律用 trace_id 找到属于自己的卡片再更新
          if (data.event === "query") {
             // 新轮开始：已有卡片（被打断轮 / 还在落库的上一轮）降级为
             // "等待保存"，原地保留到各自的 done 到达，避免半截回复闪没
             setLiveTurns(prev => [
               ...prev.map(t => ({ ...t, finalizing: true })),
               {
                 id: -1,
                 query: data.text,
                 reply_text: "",
                 intent_source: null,
                 intent_name: null,
                 command_type: null,
                 trace_id: data.trace_id
               }
             ]);
          } else if (data.event === "reply_chunk") {
             setLiveTurns(prev => prev.map(t => t.trace_id === data.trace_id
               ? { ...t, reply_text: (t.reply_text || "") + data.text } : t));
          } else if (data.event === "intent") {
             setLiveTurns(prev => prev.map(t => t.trace_id === data.trace_id ? {
               ...t,
               intent_source: data.source,
               intent_name: data.name,
               command_type: data.command,
               speaker_id: data.speaker_id ?? null,
               speaker_name: data.speaker_name ?? null,
               speaker_conflict_kind: data.speaker_conflict_kind ?? null,
               speaker_suspected: data.speaker_suspected ?? null,
               identity_debug: data.identity_debug ?? null,
             } : t));
           } else if (data.event === "done") {
              // done 表示该轮 persist 已完成，DB 数据已就绪：先拉取列表再移除
              // 自己的实时卡片，两个 setState 同批渲染，卡片原地换成历史卡片。
              // 挂到串行链上执行（见 doneRefreshChainRef）：打断场景下多个
              // done 先后到达，并发拉取的响应乱序返回会让旧快照覆盖新列表
              doneRefreshChainRef.current = doneRefreshChainRef.current.then(async () => {
                try {
                  const result = await fetchTurns(selectedSession.id, { page_size: 50 });
                  setTurns([...result.items].reverse());
                  setTurnsHasMore(result.has_more);
                  setTurnsCursor(result.next_cursor);
                  setLiveTurns(prev => prev.filter(t => t.trace_id !== data.trace_id));
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
                } catch (err) {
                  // 拉取失败不能让链断掉（后续 done 还要走这条链）；
                  // 本轮卡片保留在"保存中"状态，等下一次 done 刷新时一并换掉
                  console.error("done 后刷新对话列表失败:", err);
                }
              });
           } else if (data.event === "error") {
              // 异常轮次只移除自己的卡片，不影响其他在途轮
              setLiveTurns(prev => prev.filter(t => t.trace_id !== data.trace_id));
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
      // 连接关闭后收不到剩余的 done，在途卡片等不到移除时机，直接清掉
      setLiveTurns([]);
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
    if (liveTurns.length === 0) return;
    if (userScrolledUpRef.current) return;
    const el = turnListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [liveTurns]);

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
          <span className="app-version" data-tip="前端版本">v{__APP_VERSION__}</span>
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
          <div className="input-wrap sn">
            <input
              type="text"
              placeholder="支持部分匹配"
              value={filterSn}
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
          data-tip={filterOnline ? "显示全部会话" : "仅显示在线会话"}
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
                    <span className={`online-dot ${s.is_online ? "online" : ""}`} data-tip={s.is_online ? "在线" : "离线"} />
                    {s.device_name || s.device_sn}
                  </div>
                  <div className="session-actions">
                    <button
                      className="session-action-btn"
                      onClick={(e) => handleRenameDevice(e, s)}
                      data-tip="设置设备显示名称"
                    >
                      ✏️
                    </button>
                    {s.is_online && (
                      <button
                        className="session-action-btn new-session"
                        onClick={(e) => handleForceNewSession(e, s)}
                        disabled={!s.first_turn_at}
                        data-tip={s.first_turn_at ? "截断当前会话并新建（清空上下文）" : "当前会话暂无对话，无需新建"}
                      >
                        🔄
                      </button>
                    )}
                    <button
                      className={`session-delete-btn ${s.is_online ? "clear-only" : ""}`}
                      onClick={(e) => handleDeleteSession(e, s)}
                      disabled={s.is_online && !s.first_turn_at}
                      data-tip={s.is_online ? (s.first_turn_at ? "清除对话记录" : "当前会话暂无对话") : "删除会话"}
                    >
                      {s.is_online ? "🧹" : "🗑️"}
                    </button>
                  </div>
                </div>
                <div className="session-meta">
                  <span>👤 {s.user_id || "-"}</span>
                  <span data-tip={s.client_ip ? `客户端 IP: ${s.client_ip}` : undefined}>
                    📍 {s.location || s.client_ip || "-"}
                  </span>
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
                  会话 #{selectedSession.id} — {
                    selectedSession.device_name
                      ? `${selectedSession.device_name} (${selectedSession.device_sn})`
                      : selectedSession.device_sn
                  }
                  <span className="header-user">👤 {selectedSession.user_id || "-"}</span>
                  <button
                    className="roster-open-btn"
                    data-tip="查看/编辑该设备所属家庭的花名册"
                    onClick={() => setRosterDeviceSn(selectedSession.device_sn)}
                  >
                    👨‍👩‍👧‍👦 花名册
                  </button>
                  <button
                    className="roster-open-btn"
                    data-tip="查看该设备所属家庭的记忆条目（B 类 key 树 + A 类分页表）"
                    onClick={() => setMemoryDeviceSn(selectedSession.device_sn)}
                  >
                    🧠 记忆查询
                  </button>
                  <button
                    className="roster-open-btn"
                    data-tip="查看该设备所属家庭的记忆抽取/应用运行日志（触发原因、LLM 输出、写入统计）"
                    onClick={() => setIngestDialog({ deviceSn: selectedSession.device_sn })}
                  >
                    📋 抽取记录
                  </button>
                  <button
                    className="roster-open-btn"
                    data-tip="触发该设备的引导式人脸注册（需摄像头拉流中，注册过程由设备语音引导）"
                    onClick={() => setFaceRegDeviceSn(selectedSession.device_sn)}
                  >
                    📷 注册人脸
                  </button>
                </h2>
                <div className="content-header-actions">
                  {selectedSession.is_online && (
                    <button
                      className={`live-stream-btn ${liveStreamEnabled ? "active" : ""}`}
                      data-tip="开启后无需刷新即可查看该在线设备的实时对话流"
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
                {turns.map((t) => t.kind === "wake" ? (
                  <div key={t.id} className="turn-card wake-turn">
                    <span className="wake-icon">🔔</span>
                    <span className="wake-text">
                      设备唤醒{t.reply_text ? <>，应答「{t.reply_text}」</> : "（应答播报失败）"}
                    </span>
                    <span className="turn-time">{formatTime(t.created_at)}</span>
                    <button
                      className="turn-delete-btn"
                      data-tip="删除这条唤醒记录"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!await showConfirm("确定删除这条唤醒记录？")) return;
                        try {
                          await deleteTurn(t.id);
                          setTurns(prev => prev.filter(x => x.id !== t.id));
                        } catch (err: any) {
                          alert(`删除失败: ${err.message}`);
                        }
                      }}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div
                    key={t.id}
                    className={`turn-card ${selectedTurn?.id === t.id ? "active" : ""}`}
                    onClick={() => setSelectedTurn(t)}
                  >
                    <div className="turn-query">
                      <span className="turn-icon">👤</span>
                      <span className="turn-text">{t.query || "(无输入)"}</span>
                      <SpeakerBadge speakerId={t.speaker_id} speakerName={t.speaker_name}
                        kind={t.speaker_conflict_kind} suspected={t.speaker_suspected}
                        debug={t.identity_debug} names={speakerNames}
                        onShowDebug={setIdentityDebugShown} />
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
                      {extractedTraces && (
                        t.trace_id && extractedTraces.has(t.trace_id) ? (
                          <button
                            className="turn-ingest-btn"
                            data-tip="这轮对话已进入抽取批次，点击查看对应的抽取记录（可能与同批其他轮次一起抽取）"
                            onClick={(e) => {
                              e.stopPropagation();
                              setIngestDialog({
                                deviceSn: selectedSession.device_sn,
                                sessionId: selectedSession.id,
                                traceId: t.trace_id,
                              });
                            }}
                          >
                            📋 已抽取
                          </button>
                        ) : (
                          <span className="badge not-extracted"
                                data-tip="这轮对话尚未进入任何抽取批次（可能还在缓冲中，攒满批或静默超时后触发）">
                            未抽取
                          </span>
                        )
                      )}
                      <span className="turn-time">{formatTime(t.created_at)}</span>
                      <button
                        className="turn-delete-btn"
                        data-tip="删除这条对话记录"
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
                {turns.length === 0 && !turnsLoading && liveTurns.length === 0 && (
                  <div className="empty">暂无对话记录</div>
                )}
                {turnsLoading && turns.length === 0 && (
                  <div className="empty">
                    <div className="spinner" />
                  </div>
                )}
                {liveTurns.map((lt) => (
                  <div className="turn-card live-turn" key={lt.trace_id}>
                    <div className="turn-query">
                      <span className="turn-icon">👤</span>
                      <span className="turn-text">{lt.query || "(正在输入...)"}</span>
                      <SpeakerBadge speakerId={lt.speaker_id} speakerName={lt.speaker_name}
                        kind={lt.speaker_conflict_kind} suspected={lt.speaker_suspected}
                        debug={lt.identity_debug} names={speakerNames}
                        onShowDebug={setIdentityDebugShown} />
                    </div>
                    <div className="turn-reply">
                      <span className="turn-icon">🤖</span>
                      <span className="turn-text">{lt.reply_text || (lt.finalizing ? "" : <span className="blinking-cursor">|</span>)}</span>
                    </div>
                    <div className="turn-footer">
                      {lt.intent_source && (
                        <span className={`badge ${lt.intent_source}`}>
                          {lt.intent_source}
                        </span>
                      )}
                      {lt.intent_name && (
                        <span className="badge intent">{lt.intent_name}</span>
                      )}
                      {lt.finalizing
                        ? <span className="trace live-badge">💾 已停止，保存中...</span>
                        : <span className="trace live-badge">🔴 正在实时输出...</span>}
                    </div>
                  </div>
                ))}
              </div>

              {selectedSession.is_online && (
                <div className="test-input-panel">
                  <div className="test-input-controls">
                    <input
                      type="text"
                      className="test-input-field"
                      placeholder={liveStreaming ? "输入后发送将打断当前回复..." : "输入测试文本..."}
                      value={testInputText}
                      onChange={(e) => setTestInputText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && testInputText.trim() && !testInputLoading) {
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
                      disabled={!testInputText.trim() || testInputLoading}
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
                      {testInputLoading ? <span className="spinner inline" style={{width: 14, height: 14}}/> : (liveStreaming ? "打断并发送" : "发送测试")}
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
                  <code className="detail-trace-id" data-tip={selectedTurn.trace_id}>
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
                            <b className="speaker-detail-name" data-tip="说话时刻的名字快照">
                              {selectedTurn.speaker_name || speakerNames[selectedTurn.speaker_id]}
                            </b>
                          )}
                          <code data-tip="person_id（身份识别服务提供）">{selectedTurn.speaker_id}</code>
                          {selectedTurn.speaker_name &&
                            speakerNames[selectedTurn.speaker_id] &&
                            speakerNames[selectedTurn.speaker_id] !== selectedTurn.speaker_name && (
                            <span className="speaker-renamed" data-tip="花名册里的当前名字与当时不同">
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
                          <code data-tip="BERT 判定意图">
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
                              <code data-tip="原始意图 (BERT/规则)">
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
                          <code data-tip="最终执行指令">{selectedTurn.command_type}</code>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              </section>

              <section className="detail-section">
                <h4>🧠 记忆召回</h4>
                <MemoryRecallPanel recall={selectedTurn.memory_recall} names={speakerNames} />
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
                        client_ip: selectedSession?.client_ip ?? null,
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
      ) : activeTab === 'config' ? (
        <ConfigView />
      ) : (
        <LogMonitor />
      )}
      {/* 身份融合调试弹窗（点轮次卡片的说话人标签打开） */}
      {identityDebugShown && (
        <IdentityDebugDialog
          debug={identityDebugShown.debug}
          conflict={identityDebugShown.conflict}
          suspected={identityDebugShown.suspected}
          names={speakerNames}
          onClose={() => setIdentityDebugShown(null)}
        />
      )}
      {/* 家庭花名册对话框（按设备所属家庭）；关闭时刷新说话人名字映射（可能刚改过名） */}
      {rosterDeviceSn && (
        <RosterDialog
          deviceSn={rosterDeviceSn}
          onClose={() => {
            setRosterDeviceSn(null);
            reloadSpeakerNames();
          }}
        />
      )}
      {/* 记忆查询对话框（按设备所属家庭，只读） */}
      {memoryDeviceSn && (
        <MemoryDialog
          deviceSn={memoryDeviceSn}
          onClose={() => setMemoryDeviceSn(null)}
        />
      )}
      {/* 抽取记录对话框（记忆抽取/应用运行日志；轮次行入口带 traceId 只看该轮所在批次） */}
      {ingestDialog && (
        <MemoryIngestDialog
          deviceSn={ingestDialog.deviceSn}
          sessionId={ingestDialog.sessionId}
          traceId={ingestDialog.traceId}
          onClose={() => setIngestDialog(null)}
        />
      )}
      {/* 注册人脸对话框（触发后流程在后台进行，结果由设备语音播报） */}
      {faceRegDeviceSn && (
        <FaceRegisterDialog
          deviceSn={faceRegDeviceSn}
          onClose={() => setFaceRegDeviceSn(null)}
        />
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
