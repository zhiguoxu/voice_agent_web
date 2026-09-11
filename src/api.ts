// 后端按前缀分流（vite dev proxy 与生产 nginx 同规则）：
//   /api/voice/*    → voice_server(:8017)，代理层去掉 /voice 前缀
//   /api/agent/*    → agent_server(:8018)，原样透传（agent_server 本身就是 /api/agent 前缀）
//   /api/console/*  → console_server(:8022)，代理层去掉 /console 前缀
// 会话/轮次的 CRUD 仍在 voice_server；日志与对话实时功能（SSE、测试输入）
// 在 console_server（它把控制请求转发到持有设备连接的 voice 实例）。
export const CONVERSATIONS_API_BASE = "/api/voice/conversations";
export const LIVE_CONVERSATIONS_API_BASE = "/api/console/conversations";
export const LOGS_API_BASE = "/api/console/logs";

export interface LogEntry {
  /** DB 行 id（仅历史检索返回；实时流条目无） */
  id?: number;
  /** Redis Stream 消息 ID "ms-seq"（全局单调=console 到达序）：历史检索与
   *  实时流衔接处按它去重，同毫秒日志也按它决胜排序（须数值比较，见 compareUid） */
  uid?: string;
  /** epoch 毫秒时间戳（time 字符串仅供展示） */
  ts?: number;
  source?: string;
  /** 来源实例标识 "hostname:port"（同 source 多实例部署时区分谁发的；旧日志无） */
  instance?: string;
  time: string;
  level: string;
  msg: string;
  device_sn: string;
  trace_id: string;
  file: string;
  module?: string;
  function: string;
  line: number;
  name: string;
  /** 异常堆栈全文（仅 logger.exception 记录的日志携带） */
  exc?: string;
}

export interface LogSearchParams {
  /** 设备号，完全匹配（服务端走索引） */
  device_sn?: string;
  /** Trace ID，完全匹配（服务端走索引） */
  trace_id?: string;
  /** 不低于该级别 */
  level?: string;
  source?: string;
  /** 来源实例标识，完全匹配 */
  instance?: string;
  /** 消息、Trace、设备、实例或代码位置，部分匹配 */
  text?: string;
  start_ms?: number;
  end_ms?: number;
  /** 上一页最后一行的 id，向更旧翻页 */
  cursor?: number;
  limit?: number;
}

export interface LogSearchResult {
  items: LogEntry[];
  /** 非空表示后面还有：页已填满，或服务端扫描因时间预算中途停下；传回 cursor 继续 */
  next_cursor: number | null;
  /** 服务端因时间预算提前停下时，本次已覆盖到的最旧日志时刻（epoch 毫秒）；
   *  页已填满或已扫到底则为 null */
  scanned_to_ts: number | null;
}

/** 检索 DB 历史日志（新→旧排序，游标分页）。
 *  无 SN/Trace 的检索在服务端按时间预算分段扫描：找不到匹配时不会扫完整表才回，
 *  而是先返回已找到的行 + next_cursor（未扫区间上界），调用方凭 cursor 续扫。 */
export async function searchLogs(params: LogSearchParams = {}): Promise<LogSearchResult> {
  const sp = new URLSearchParams();
  if (params.device_sn) sp.set("device_sn", params.device_sn);
  if (params.trace_id) sp.set("trace_id", params.trace_id);
  if (params.level) sp.set("level", params.level);
  if (params.source) sp.set("source", params.source);
  if (params.instance) sp.set("instance", params.instance);
  if (params.text) sp.set("text", params.text);
  if (params.start_ms != null) sp.set("start_ms", String(params.start_ms));
  if (params.end_ms != null) sp.set("end_ms", String(params.end_ms));
  if (params.cursor != null) sp.set("cursor", String(params.cursor));
  sp.set("limit", String(params.limit ?? 500));
  const res = await fetch(`${LOGS_API_BASE}/search?${sp}`);
  if (!res.ok) throw new Error("Failed to search logs");
  const data = await res.json();
  return {
    items: data.items ?? [],
    next_cursor: data.next_cursor ?? null,
    scanned_to_ts: data.scanned_to_ts ?? null,
  };
}

/** 服务端单次请求最多扫约 1s；找不到时自动续扫的轮数上限，超过后交给用户点「继续搜索更早」 */
const LOG_SCAN_AUTO_ROUNDS = 20;

/** 取一页（最多 pageSize 条）历史日志，服务端因时间预算中途停下时自动带 cursor 续扫，
 *  每收到一段就 yield 一次让 UI 逐步展示；页满、扫到底或达到轮数上限即结束。
 *  yield 的 partial 为 true 表示服务端还没扫完（next_cursor 指向未扫区间）。 */
export async function* scanLogPages(
  params: LogSearchParams,
  cursor: number | undefined,
  pageSize: number
): AsyncGenerator<LogSearchResult & { partial: boolean }> {
  let got = 0;
  for (let round = 0; round < LOG_SCAN_AUTO_ROUNDS; round++) {
    const page = await searchLogs({ ...params, cursor, limit: pageSize - got });
    got += page.items.length;
    // 页未满却还有 cursor，只可能是服务端到了时间预算提前停下
    const partial = page.next_cursor != null && got < pageSize;
    yield { ...page, partial };
    if (!partial) return;
    cursor = page.next_cursor!;
  }
}

export interface Session {
  id: number;
  device_sn: string;
  /** 设备显示名称（控制台起的好记名字），未命名为 null */
  device_name?: string | null;
  user_id: string;
  device_type_id: string;
  /** 客户端真实 IP（服务端解析代理头所得），历史会话可能为 null */
  client_ip: string | null;
  location: string | null;
  created_at: string | null;
  last_active_at: string | null;
  first_turn_at: string | null;
  last_turn_at: string | null;
  is_online: boolean;
}

/** 记忆检索计划（family_memory.RecallPlan，查询理解的输出） */
/** 双塔 top 候选（纯调试）：服务端原始 key + 余弦，key 为归一到注册表的结果（null = 被滤掉） */
export interface KeyCandidate {
  raw: string;
  score: number;
  key: string | null;
}

export interface RecallPlan {
  subjects: string[];
  /** 相关 key 集合（可含 root，召回端按注册表展开；空 = 纯语义 A 类检索）。
   *  升级前落库的旧 trace 无此字段（当时是单数 key + scope，均已裁撤）。 */
  keys?: string[];
  /** 本轮 query 自身解出的 key（未融合）。keys 中不被 own_keys 覆盖的项 =
   *  上下文融合从上文继承的 key（本轮没扣出时并入最近一次扣出的，2026-07 起）；
   *  升级前落库的旧 trace 无此字段（当时 keys 恒为本轮自身结果）。 */
  own_keys?: string[];
  /** 双塔原始 top5 候选（仅双塔被实际调用且有应答的轮次非空；旧 trace 无此字段） */
  key_candidates?: KeyCandidate[];
  extremum: boolean;
  reverse: boolean;
  temporal: string;
  confidence: string;
  topic: string;
}

/** 一条召回的记忆条目（family_memory.RecalledMemory；succ 为变更链后继） */
export interface RecalledMemory {
  memory_id: number;
  content: string;
  mem_type: string;
  subjects: string[];
  subject_names: string[];
  tag: { key: string; value: string; is_extremum: boolean } | null;
  status: string;
  succ: RecalledMemory | null;
  chain_open: boolean;
  superseded_at: string | null;
  created_at: string | null;
  due_at: string | null;
  /** 召回打分（与查询向量点积/字面兜底）；链后继补回的行无分 */
  score: number | null;
}

/** 一轮对话的记忆召回过程记录（family_memory.RecallTrace，调试用） */
export interface MemoryRecall {
  query: string;
  asker_id: string | null;
  plan: RecallPlan | null;
  records: RecalledMemory[];
  block: string;
  plan_ms: number | null;
  search_ms: number | null;
  total_ms: number | null;
  error: string | null;
}

/** 单轮身份融合过程记录（后端 identity.IdentityDebug 的 JSON——运行时类型整体
 *  dump，这里只声明 web 实际读取的字段，后端可多不可少；
 *  点说话人标签的调试弹窗展示。person_id 未启用等无融合过程的轮次为 null。 */
export interface IdentityDebug {
  /** 视觉识别层原始结果（融合前） */
  vision: {
    person_id: string | null;
    recognition: string;            // known / suspected / unknown
    fused_score: number | null;     // person_id 服务的多模态融合匹配分
    status: string | null;          // 服务端原始置信档位 definite/confident/...
  };
  /** 声纹比对原始结果。person_id/score/confidence 是过阈值的结论；
   *  top_person_id/top_score 是不设阈值的原始最像者 */
  voice: {
    person_id: string | null;
    score: number | null;
    confidence: string | null;      // high / low
    net_speech_sec: number;
    top_person_id: string | null;
    top_score: number | null;
    /** 本家每个有声纹模板的成员对本轮语音的相似分（person_id → 分，降序）；
     *  声纹库为空/声音太短时为空对象，该字段落库前的老轮次没有此键 */
    scores?: Record<string, number>;
  };
  /** 镜头里的人自己的声纹分（仅"视觉认出A+声纹top-1指向他人"的仲裁场景才有） */
  vision_person_voice_score: number | null;
  /** 融合结论（本轮最终采用的身份及仲裁走向） */
  fusion: {
    person_id: string | null;
    recognition: string;
    source: string | null;          // vision / voice
    conflict_kind: string | null;   // voice_override / conflict_unknown / voice_doubt
  };
}

/** 单轮视觉门控决策快照（agent_server vision_gate 的 debug dict）。
 *  仅门控真实评估过的轮次有值（无图/未启用轮为 null）。 */
export interface VisionGate {
  /** attach=带图 / skip=省图（本轮是否把摄像头画面给 LLM） */
  decision: "attach" | "skip";
  /** 模型输出的 P(需要视觉)；服务异常 fail-open 时无 */
  p_vision?: number;
  /** 判定时生效的阈值（P ≥ 阈值才带图） */
  threshold?: number;
  /** error=门控服务异常（fail-open 照常带图） */
  reason?: string;
  error?: string;
}

export interface Turn {
  id: number;
  trace_id: string;
  /** 记录类别："chat"=对话轮 / "wake"=唤醒记录 / "noise"=拾音未识别
   *  （VAD 判有人声但 ASR 结果为空，语音留档可回放）。非 chat 仅调试展示，不进 LLM 上下文 */
  kind: string;
  query: string;
  speaker_id: string | null;
  speaker_name: string | null;
  /** 声画冲突仲裁走向：null=无冲突 / voice_override / conflict_unknown / voice_doubt；
   *  voice_doubt=归镜头者但这句话声音存疑（标签「冲突」记号） */
  speaker_conflict_kind: string | null;
  /** 疑似识别标记：speaker_id 是"最像的人"可能认错（voice_doubt 弱冲突轮并在此档），
   *  标签带「疑似」记号 */
  speaker_suspected: boolean | null;
  /** 身份融合过程记录：点说话人标签展示；无融合过程的轮次为 null */
  identity_debug: IdentityDebug | null;
  /** 视觉门控决策快照：带图/省图、P(vision)、阈值；未评估的轮次为 null */
  vision_gate: VisionGate | null;
  reply_text: string | null;
  /** 输出侧风控：true=本轮回复被拦截替换（reply_text 已是替代话术，
   *  下一轮 LLM 历史只见替代文本） */
  moderated: boolean | null;
  /** 风控命中来源：rule=正则规则层 / llm=风控模型层 */
  moderation_source: string | null;
  /** 被拦截的原始已产出文本（可能不完整），仅审计展示，不进 LLM 上下文 */
  moderation_original_text: string | null;
  /** 实际送审被判风险的文本。模型层=跨阈值前缀（与 original 可能不同）；规则层=命中时全文 */
  moderation_checked_text: string | null;
  /** 打断标记：true=回复未完整产出就被新输入打断（半截回复照常展示，
   *  但不进后续 LLM 历史——半截回复进历史会教模型模仿"答一半就停"） */
  interrupted: boolean | null;
  /** 本轮异常/失败信息，正常轮为 null。chat 轮：处理异常（轮次照常落库，
   *  query/部分回复尽力保存）；wake 轮：应答音由客户端本地播放，新行恒为
   *  null，有值的是云端播应答时期的存量失败行 */
  error_message: string | null;
  intent_source: string | null;
  intent_name: string | null;
  command_type: string | null;
  subagent_name: string | null;
  input_audio_cos_key: string | null;
  image_cos_key: string | null;
  tts_audio_cos_key: string | null;
  t_vad_start: number | null;
  t_vad_end: number | null;
  t_asr_done: number | null;
  t_agent_start: number | null;
  t_history_done: number | null;
  t_identity_done: number | null;
  /** 视觉门控（与历史/身份并发的第三条腿，仅带图轮才调用） */
  t_vision_gate_start: number | null;
  t_vision_gate_done: number | null;
  t_names_done: number | null;
  t_memory_done: number | null;
  t_stateless_start: number | null;
  /** LLM 意图分类打点；后端已兼容旧数据的 t_bert_* 键名 */
  t_intent_start: number | null;
  t_intent_done: number | null;
  t_subagent_start: number | null;
  t_subagent_done: number | null;
  /** 动作/表情生成（emote_action）：与主链路并行的后台任务；本轮先落库时 done 可能为空 */
  t_emote_action_start: number | null;
  t_emote_action_done: number | null;
  /** 下发的动作/表情, 如 "59(开心挥手)"; 未下发为空 */
  emote_action_sent: string | null;
  emote_face_sent: string | null;
  t_llm_tool_start: number | null;
  t_llm_tool_done: number | null;
  t_tool_execute_start: number | null;
  t_tool_execute_done: number | null;
  tool_names: string | null;
  tool_arguments: string | null;
  tool_results: string | null;
  /** attach_image: 本轮 LLM 消息是否实际携带画面（消息构造的唯一开关；存量快照后端已归一成 true） */
  /** device_status: 构造提示词时的设备状态快照（按后端字段名序列化，如 iccid_4g）；提示词目前只消费 is_on_car */
  chat_request: { query: string; history: { role: string; content: string }[]; system_prompt: string | null; prompt_memory?: string | null; prompt_time?: string | null; device_status?: ({ is_on_car?: boolean | null } & Record<string, unknown>) | null; image_url: string | null; attach_image?: boolean; llm: { model: string; base_url: string } | null } | null;
  /** 本轮记忆召回过程记录；记忆未启用/老数据无此字段时为空 */
  memory_recall: MemoryRecall | null;
  t_llm_start: number | null;
  t_llm_first_token: number | null;
  t_first_token: number | null;
  t_agent_done: number | null;
  t_tts_first_audio: number | null;
  created_at: string | null;
}

export interface CursorResult<T> {
  items: T[];
  has_more: boolean;
  next_cursor: number | null;
}

export interface TraceResult {
  session: Session;
  turn: Turn;
}

/**
 * 兼容新旧 API 响应格式:
 * - 新: { items, has_more, next_cursor }
 * - 旧: { items, total, page, page_size }
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeCursorResult<T extends { id: number }>(raw: any): CursorResult<T> {
  if ("has_more" in raw) return raw;
  // 旧格式兼容
  const items: T[] = raw.items ?? [];
  const total: number = raw.total ?? 0;
  const page: number = raw.page ?? 1;
  const pageSize: number = raw.page_size ?? 20;
  return {
    items,
    has_more: page * pageSize < total,
    next_cursor: items.length > 0 ? items[items.length - 1].id : null,
  };
}

export async function fetchSessions(
  params: {
    /** 按设备 SN 或设备显示名称模糊筛选（后端两者都匹配） */
    device_sn?: string;
    user_id?: string;
    start_time?: string;
    end_time?: string;
    cursor?: number;
    page_size?: number;
  } = {}
): Promise<CursorResult<Session>> {
  const sp = new URLSearchParams();
  if (params.device_sn) sp.set("device_sn", params.device_sn);
  if (params.user_id) sp.set("user_id", params.user_id);
  if (params.start_time) sp.set("start_time", params.start_time);
  if (params.end_time) sp.set("end_time", params.end_time);
  if (params.cursor != null) sp.set("cursor", String(params.cursor));
  sp.set("page_size", String(params.page_size ?? 20));
  const res = await fetch(`${CONVERSATIONS_API_BASE}/sessions?${sp}`);
  return normalizeCursorResult<Session>(await res.json());
}

/** 按 id 精确查单个会话（分享链接直达列表首页之外的老会话用） */
export async function fetchSessionById(sessionId: number): Promise<Session> {
  const res = await fetch(`${CONVERSATIONS_API_BASE}/sessions/${sessionId}`);
  if (!res.ok) throw new Error("Failed to fetch session");
  return res.json();
}

export async function fetchTurns(
  sessionId: number,
  params: { cursor?: number; page_size?: number } = {}
): Promise<CursorResult<Turn>> {
  const sp = new URLSearchParams();
  if (params.cursor != null) sp.set("cursor", String(params.cursor));
  sp.set("page_size", String(params.page_size ?? 50));
  const res = await fetch(`${CONVERSATIONS_API_BASE}/sessions/${sessionId}/turns?${sp}`);
  return normalizeCursorResult<Turn>(await res.json());
}

export async function fetchTurnByTrace(traceId: string): Promise<TraceResult> {
  const res = await fetch(`${CONVERSATIONS_API_BASE}/turns/by-trace/${encodeURIComponent(traceId)}`);
  if (!res.ok) throw new Error("Failed to fetch turn by trace");
  return res.json();
}

export async function deleteSession(sessionId: number): Promise<void> {
  const res = await fetch(`${CONVERSATIONS_API_BASE}/sessions/${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete session");
}

export async function clearSessionTurns(sessionId: number): Promise<void> {
  const res = await fetch(`${CONVERSATIONS_API_BASE}/sessions/${sessionId}/turns`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to clear session turns");
}

export async function deleteLastTurn(sessionId: number): Promise<void> {
  const res = await fetch(`${CONVERSATIONS_API_BASE}/sessions/${sessionId}/last_turn`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("No turns to delete");
}

export async function deleteTurn(turnId: number): Promise<void> {
  const res = await fetch(`${CONVERSATIONS_API_BASE}/turns/${turnId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete turn");
}

/** 对话复现时重建的当时风控送审上下文（与生产 open_reply_check user 消息同构造） */
export interface ReplayModerationSubmitted {
  query: string;
  history: string;
  /** 本次复现实际送进风控的【机器人回复】 */
  reply_text: string;
  /** checked=跨阈值送审前缀; original=规则层全文; original_fallback=存量无前缀;
   *  reply=未拦截完整回复; replay=本次 agent 复现的最新出文（模式切换） */
  reply_origin: "checked" | "original" | "original_fallback" | "reply" | "replay" | "missing";
  /** 当时落库的送审文本（reply_origin=replay 时用来和最新出文对照） */
  recorded_reply_text: string | null;
  /** 命中时刻全量累计原文（可能比送审前缀长） */
  original_text: string | null;
  /** 落库的实际送审前缀；存量拦截轮可能为空 */
  checked_text: string | null;
  /** 实际发给风控 LLM 的 user 正文 */
  user_content: string;
  context_turns: number;
  history_turn_count: number;
  turn_moderated: boolean;
  turn_moderation_source: string | null;
}

export interface ReplayModeration {
  skipped?: string | null;
  error?: string | null;
  submitted?: ReplayModerationSubmitted | null;
  /** 本次 agent 新出文与当时送审文本是否不同 */
  replay_reply_differs?: boolean;
  enabled?: boolean;
  rule?: ModerationTestResult["rule"];
  llm?: ModerationTestResult["llm"];
  final?: ModerationTestResult["final"];
}

export interface ReplayResult {
  reply_text: string;
  intent_source: string | null;
  intent_name: string | null;
  command_type: string | null;
  subagent_name: string | null;
  /** true=本次用当前生效的 small_talk 重装了 system_prompt */
  used_latest_prompt?: boolean;
  /** true=本次重装提示词时时间/日期块用了当前时刻（实际生效值:
   *  未开 used_latest_prompt 时恒为 false） */
  used_latest_time?: boolean;
  /** true=本次按当前门控模型重判了 attach_image（关闭时原样用快照决策） */
  recomputed_vision_gate?: boolean;
  /** 门控重算的决策快照；未开重算或无图轮为 null */
  vision_gate?: VisionGate | null;
  chat_request?: { system_prompt?: string | null } | null;
  moderation?: ReplayModeration | null;
  timing: {
    t_agent_start?: number | null;
    t_history_done?: number | null;
    t_identity_done?: number | null;
    t_vision_gate_start?: number | null;
    t_vision_gate_done?: number | null;
    t_names_done?: number | null;
    t_memory_done?: number | null;
    t_stateless_start?: number | null;
    t_intent_start?: number | null;
    t_intent_done?: number | null;
    t_subagent_start?: number | null;
    t_subagent_done?: number | null;
    t_emote_action_start?: number | null;
    t_emote_action_done?: number | null;
    emote_action_sent?: string | null;
    emote_face_sent?: string | null;
    t_llm_tool_start?: number | null;
    t_llm_tool_done?: number | null;
    t_tool_execute_start?: number | null;
    t_tool_execute_done?: number | null;
    tool_names?: string | null;
    tool_arguments?: string | null;
    tool_results?: string | null;
    t_llm_start?: number | null;
    t_llm_first_token?: number | null;
    t_first_token?: number | null;
    t_agent_done?: number | null;
  };
}

export async function replayTurn(chatRequest: object): Promise<ReplayResult> {
  const res = await fetch(`${CONVERSATIONS_API_BASE}/replay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatRequest),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Replay failed: ${detail}`);
  }
  return res.json();
}

// device_sn: console_server 按设备定位持有 WebSocket 的 voice 实例（在线标记按设备键）
export async function testSessionInput(sessionId: number, deviceSn: string, text: string, withTts: boolean): Promise<void> {
  const res = await fetch(`${LIVE_CONVERSATIONS_API_BASE}/sessions/${sessionId}/test_input?device_sn=${encodeURIComponent(deviceSn)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, with_tts: withTts }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Test input failed: ${detail}`);
  }
}

// ── VAD 前原始音频录制（调试）────────────────────────────────────────────
// 控制走 console 转发（须命中持有设备 WebSocket 的 voice 实例）；
// 列表走 voice 的 CRUD 接口（数据在 COS，任意实例可查）。

/** 一段录制内的 VAD 激活区间（相对段起点的毫秒偏移） */
export interface RawAudioVadInterval {
  start_ms: number;
  end_ms: number;
  /** 该区间对应轮次的 trace_id（录制开始前已在途的语音可能为 null） */
  trace_id: string | null;
  /** 该轮次的 query 文本（列表接口按 trace_id 现查轮次表回填）。
   *  null = 无对应轮次（被删/未落库）；"" = 拾音未识别（noise 轮） */
  query?: string | null;
}

/** 一段原始音频录制（以 1s 无新数据为分割点自动切段） */
export interface RawAudioItem {
  device_sn: string;
  session_id: number;
  /** 段起始时间（产品时区 ISO） */
  start_time: string;
  duration_ms: number;
  sample_rate: number;
  /** WAV 的 COS key，经 /media?key= 换临时链接播放/下载 */
  wav_key: string;
  vad_intervals: RawAudioVadInterval[];
}

async function rawRecordControl(sessionId: number, deviceSn: string, op: "start" | "stop" | "status"): Promise<{ recording: boolean }> {
  const res = await fetch(`${LIVE_CONVERSATIONS_API_BASE}/sessions/${sessionId}/raw_record/${op}?device_sn=${encodeURIComponent(deviceSn)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: op === "start" ? JSON.stringify({ max_seconds: 1800 }) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`raw_record ${op} failed: ${detail}`);
  }
  return res.json();
}

export const rawRecordStart = (sessionId: number, deviceSn: string) => rawRecordControl(sessionId, deviceSn, "start");
export const rawRecordStop = (sessionId: number, deviceSn: string) => rawRecordControl(sessionId, deviceSn, "stop");
export const rawRecordStatus = (sessionId: number, deviceSn: string) => rawRecordControl(sessionId, deviceSn, "status");

/** 拉取该会话已落 COS 的原始音频段列表（新→旧） */
export async function fetchRawAudioList(sessionId: number): Promise<RawAudioItem[]> {
  const res = await fetch(`${CONVERSATIONS_API_BASE}/sessions/${sessionId}/raw_audio`);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`获取原始音频列表失败: ${detail}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

/** 回放一段原始录音：音频走与设备上行完全一致的 VAD→ASR→对话链路（test_input 的语音版）。
 *  立即返回，后台按录音真实节奏回放；回放期间设备上行音频被丢弃。 */
export async function testSessionAudio(sessionId: number, deviceSn: string, wavKey: string, realtime = true): Promise<void> {
  const res = await fetch(`${LIVE_CONVERSATIONS_API_BASE}/sessions/${sessionId}/test_audio?device_sn=${encodeURIComponent(deviceSn)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wav_key: wavKey, realtime }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`回放失败: ${detail}`);
  }
}

/** 上传本地 WAV 文件回放（testSessionAudio 的上传版，回放语义相同）；返回音频时长 ms */
export async function testSessionAudioUpload(sessionId: number, deviceSn: string, file: File, realtime = true): Promise<number> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("realtime", String(realtime));
  const res = await fetch(`${LIVE_CONVERSATIONS_API_BASE}/sessions/${sessionId}/test_audio/upload?device_sn=${encodeURIComponent(deviceSn)}`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`回放失败: ${detail}`);
  }
  const data = await res.json();
  return data.duration_ms ?? 0;
}

/** 停止在途的录音回放（幂等） */
export async function testSessionAudioStop(sessionId: number, deviceSn: string): Promise<void> {
  const res = await fetch(`${LIVE_CONVERSATIONS_API_BASE}/sessions/${sessionId}/test_audio/stop?device_sn=${encodeURIComponent(deviceSn)}`, {
    method: "POST",
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`停止回放失败: ${detail}`);
  }
}

/** 删除一个录制段（COS 上的 WAV + 元数据 JSON） */
export async function deleteRawAudio(sessionId: number, wavKey: string): Promise<void> {
  const res = await fetch(
    `${CONVERSATIONS_API_BASE}/sessions/${sessionId}/raw_audio?key=${encodeURIComponent(wavKey)}`,
    { method: "DELETE" });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`删除失败: ${detail}`);
  }
}

export async function forceNewSession(sessionId: number, deviceSn: string): Promise<{ new_session_id: number }> {
  const res = await fetch(`${LIVE_CONVERSATIONS_API_BASE}/sessions/${sessionId}/force_new?device_sn=${encodeURIComponent(deviceSn)}`, {
    method: "POST",
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Force new session failed: ${detail}`);
  }
  return res.json();
}

export interface RosterMember {
  person_id: string;
  name: string | null;
  aliases: string[];
  role: string | null;
  gender: string | null;
  birth_year: number | null;
  /** 声纹模板条数，0=未录入声纹 */
  voice_templates: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface RosterRelation {
  subject_id: string;
  relation: string;
  object_id: string;
  created_at: string | null;
}

export interface RosterData {
  enabled: boolean;
  members: RosterMember[];
  relations: RosterRelation[];
  prompt_block: string;
}

// 记忆相关接口在 agent_server 上（/api/agent/* 由代理层直达 agent_server，
// 与 voice_server 无关）。花名册按设备所属家庭获取（多家庭同库，不做全库 dump）。
export async function fetchRoster(deviceSn: string): Promise<RosterData> {
  const res = await fetch(`/api/agent/roster?device_sn=${encodeURIComponent(deviceSn)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch roster");
  }
  return res.json();
}

/** 花名册成员删除结果（人脸/花名册/记忆三步联动的各自结果） */
export interface RosterMemberDeleteResult {
  ok: boolean;
  roster_deleted: boolean;
  face_deleted: boolean;
  memory_deleted_items: number;
  message: string;
}

/** 删除花名册成员：联动删除 person_id 底库里此人的人脸（device_sn 定位底库），
 *  以及此人的全部记忆条目（含与他人共享的条目整条删，物理删除不可恢复）。 */
export async function deleteRosterMember(
  personId: string, deviceSn: string,
): Promise<RosterMemberDeleteResult> {
  const res = await fetch(
    `/api/agent/roster/${encodeURIComponent(personId)}?device_sn=${encodeURIComponent(deviceSn)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to delete roster member");
  }
  return res.json();
}

/** 成员属性编辑载荷：显式传 null 表示清空该字段，省略表示不动 */
export interface RosterMemberPatch {
  name?: string | null;
  aliases?: string[];
  role?: string | null;
  gender?: string | null;
  birth_year?: number | null;
}

export async function updateRosterMember(
  personId: string, deviceSn: string, patch: RosterMemberPatch,
): Promise<void> {
  const res = await fetch(`/api/agent/roster/${encodeURIComponent(personId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn, ...patch }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to update roster member");
  }
}

export async function addRosterRelation(
  deviceSn: string, subjectId: string, relation: string, objectId: string,
): Promise<void> {
  const res = await fetch("/api/agent/roster/relations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_sn: deviceSn, subject_id: subjectId, relation, object_id: objectId,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to add roster relation");
  }
}

export async function deleteRosterRelation(
  deviceSn: string, subjectId: string, relation: string, objectId: string,
): Promise<void> {
  const res = await fetch("/api/agent/roster/relations/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_sn: deviceSn, subject_id: subjectId, relation, object_id: objectId,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to delete roster relation");
  }
}

/** 人脸注册的最终结果（接口同步执行完整个流程，成功时必有 person_id） */
export interface FaceRegisterResult {
  success: boolean;
  /** 尽量透传 person_id 原始状态。成功: registered(新入库) | already_known
   *  (人已在库，细节看 message)；前置检查失败: person_id_disabled |
   *  memory_disabled | busy | person_id_unreachable(服务查询失败，非摄像头
   *  问题) | camera_open_failed(未拉流且自动开流失败) | duplicate_name；
   *  探测失败(透传失败码): 3 轮均失败时透传最后一次 (camera_offline |
   *  no_target | no_face | low_face_quality | face_cut_top | face_cut_bottom |
   *  face_cut_side 等，兜底 enroll_failed)，
   *  服务调用失败则立即中止 (error | disabled)；
   *  其他: cancelled (调用方经 cancelFaceRegister 取消，人脸未入库) |
   *  name_save_failed (人脸已入库但名字没写上，重试注册可自愈，
   *  person_id 有值) | internal_error */
  status: string;
  message: string;
  person_id: string | null;
}

/** 触发一次引导式人脸注册。同步接口：阻塞到流程结束（未拉流会先自动开启
 *  摄像头，再最多 3 轮 × 每轮 4 次带质量门槛的注册探测，通常几十秒），
 *  期间设备会语音引导用户；返回最终结果。中途退出要调 cancelFaceRegister，
 *  只放弃这条请求后端不会停。
 *  issApiUrl: ISS 推流服务地址覆盖（自动开流用，与拉流控制同一份输入）；
 *  空 = 用 person_id 配置的地址。 */
export async function registerFace(
  deviceSn: string, name: string, issApiUrl: string,
): Promise<FaceRegisterResult> {
  const res = await fetch("/api/agent/face/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn, name, iss_api_url: issApiUrl }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "触发人脸注册失败");
  }
  return res.json();
}

/** 取消该设备进行中的人脸注册（幂等，没有进行中的也返回成功）。后端在最近的
 *  检查点停止并播报「人脸注册已取消」，阻塞中的 registerFace 随即返回
 *  status=cancelled；人脸刚好已入库时不可取消，那次 registerFace 会返回成功。 */
export async function cancelFaceRegister(deviceSn: string): Promise<void> {
  const res = await fetch("/api/agent/face/register/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "取消人脸注册失败");
  }
}

/** person_id 服务端拉流消费状态（StreamStatusResponse 原样透传，只声明 web 读取的字段） */
export interface StreamConsumeStatus {
  camera_id: string;
  running: boolean;
  /** 是否已成功连上视频流；「正在拉流」的口径是 running 且 connected */
  connected: boolean;
  url: string | null;
  stream_width: number;
  stream_height: number;
  frames_read: number;
  frames_processed: number;
  process_fps: number;
  /** 这路流实际使用的 ISS 地址（请求覆盖或 person_id 配置） */
  iss_api_url: string;
  auto_restream: boolean;
  /** 断流自动恢复流程（在线检查/ISS 重推）进行中 */
  recovering: boolean;
  restream_count: number;
  last_error: string | null;
}

export interface StreamStatusData {
  /** person_id 人物识别能力是否开启（关闭时按钮不显示） */
  enabled: boolean;
  /** person_id 服务是否可达（不可达 ≠ 未拉流，展示上要区分） */
  reachable: boolean;
  status: StreamConsumeStatus | null;
}

/** 查询设备摄像头的服务端拉流状态（camera_id = device_sn，控制台周期轮询） */
export async function fetchStreamStatus(deviceSn: string): Promise<StreamStatusData> {
  const res = await fetch(`/api/agent/stream/status?device_sn=${encodeURIComponent(deviceSn)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "查询拉流状态失败");
  }
  return res.json();
}

/** 开启拉流：经 ISS 开启设备推流拿 FLV 地址，再让 person_id 服务端消费。幂等。
 *  issApiUrl: ISS 地址覆盖，空 = 用 person_id 配置的地址。 */
export async function startStreamConsume(
  deviceSn: string, issApiUrl: string,
): Promise<StreamConsumeStatus> {
  const res = await fetch("/api/agent/stream/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn, iss_api_url: issApiUrl }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "开启拉流失败");
  }
  return res.json();
}

/** 关闭拉流：先停服务端消费，再停设备推流。对未在拉流的设备幂等。
 *  停推流打哪套 ISS 由后端按这路流开流时的地址决定，前端不用再传。 */
export async function stopStreamConsume(deviceSn: string): Promise<StreamConsumeStatus> {
  const res = await fetch("/api/agent/stream/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "关闭拉流失败");
  }
  return res.json();
}

/** 声纹录入 start 的结果 */
export interface VoiceEnrollStartResult {
  success: boolean;
  /** ok | voice_identity_disabled | memory_disabled | person_not_found(不在本家
   *  花名册，请先完成人脸注册) | busy | device_offline | voice_server_unreachable |
   *  internal_error(录入状态存取失败等) */
  status: string;
  message: string;
}

/** 声纹录入 finish 的结果。finish 之后本次流程必然结束（后端状态已清）：
 *  质量不合格时设备已播报针对性提示，是否重试由用户决定——再点「开始录入」
 *  就重新走一遍，次数不限。 */
export interface VoiceEnrollFinishResult {
  success: boolean;
  /** 成功: registered；质量不合格(可重新点开始录入再试): no_speech |
   *  too_short | low_volume | noisy；其他失败: not_started |
   *  capture_lost(采集超时/设备断连，需重新发起) |
   *  voice_conflict(声音与已有成员过像) | embed_failed | person_deleted |
   *  voice_server_unreachable | internal_error */
  status: string;
  message: string;
  net_speech_sec: number | null;
  person_id: string | null;
}

/** 开始声纹录入：打开设备侧采集并语音提示用户照屏幕文本朗读。
 *  成员须已完成人脸注册（person_id 直接取自花名册，不依赖实时视频流）。 */
export async function startVoiceEnroll(
  deviceSn: string, personId: string,
): Promise<VoiceEnrollStartResult> {
  const res = await fetch("/api/agent/voice/enroll/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn, person_id: personId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "开始声纹录入失败");
  }
  return res.json();
}

/** 用户读完点击「完成朗读」：评估本次朗读，合格入库，不合格自动语音引导重试。 */
export async function finishVoiceEnroll(deviceSn: string): Promise<VoiceEnrollFinishResult> {
  const res = await fetch("/api/agent/voice/enroll/finish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "完成声纹录入失败");
  }
  return res.json();
}

/** 声纹删除的结果 */
export interface VoiceprintEraseResult {
  success: boolean;
  /** ok | memory_disabled | person_not_found(不在本设备所属家庭的花名册) */
  status: string;
  deleted_templates: number;
  message: string;
}

/** 删除成员的全部声纹模板（人脸/花名册/记忆都保留，此后声音不再被认出，
 *  可随时重新录入）。删除成员本身走 deleteRosterMember。 */
export async function deleteVoiceprint(
  personId: string, deviceSn: string,
): Promise<VoiceprintEraseResult> {
  const res = await fetch(
    `/api/agent/voice/templates/${encodeURIComponent(personId)}?device_sn=${encodeURIComponent(deviceSn)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "删除声纹失败");
  }
  return res.json();
}

/** 一条声纹模板（正在参与比对），可回放产生它的录音 */
export interface VoiceTemplateItem {
  id: number;
  /** reading=朗读录入 | auto=对话自动增量 | null=补列前的存量行（来源未知） */
  source: "reading" | "auto" | null;
  net_speech_sec: number;
  /** 录音的 COS key（朗读: 那次采集的整段音频；自动: 那轮的输入语音），经
   *  cosMediaUrl 换临时链接播放；留档是 best-effort，可能指向不存在的对象；null=未留档 */
  audio_key: string | null;
  /** 朗读录入那次采集的元数据；自动增量模板与存量行为 null */
  capture_meta: VoiceCaptureMeta | null;
  created_at: string | null;
}

/** 朗读录入采集的质量指标与送提取区间（与 audio_key 指向的 WAV 配套） */
export interface VoiceCaptureMeta {
  frames: number;
  /** 整段采集音频时长（含等待期与停顿静音） */
  duration_ms: number;
  /** 语音响度（dBFS） */
  speech_level_db: number;
  /** 底噪（dBFS） */
  noise_level_db: number;
  snr_db: number;
  /** WAV 里实际送去提取向量的区间 [start, end)（毫秒）；全程静音为 null */
  embed_span_ms: [number, number] | null;
}

export interface VoiceTemplateListResult {
  success: boolean;
  /** ok | memory_disabled | person_not_found */
  status: string;
  person_id: string;
  name: string;
  /** 入库先后（旧→新） */
  items: VoiceTemplateItem[];
  message: string;
}

/** 列出成员的全部声纹模板（含来源与录音 key） */
export async function fetchVoiceTemplates(
  personId: string, deviceSn: string,
): Promise<VoiceTemplateListResult> {
  const res = await fetch(
    `/api/agent/voice/templates/${encodeURIComponent(personId)}?device_sn=${encodeURIComponent(deviceSn)}`,
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "获取声纹模板列表失败");
  }
  return res.json();
}

export interface VoiceTemplateDeleteResult {
  success: boolean;
  /** ok | memory_disabled | person_not_found | template_not_found */
  status: string;
  templates_left: number;
  message: string;
}

/** 删除成员的一条声纹模板（只删模板不删录音，剩余模板照常参与比对） */
export async function deleteVoiceTemplate(
  personId: string, templateId: number, deviceSn: string,
): Promise<VoiceTemplateDeleteResult> {
  const res = await fetch(
    `/api/agent/voice/templates/${encodeURIComponent(personId)}/${templateId}`
    + `?device_sn=${encodeURIComponent(deviceSn)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "删除声纹模板失败");
  }
  return res.json();
}

/** COS 对象的播放/下载地址：经 voice_server 307 跳转到临时链接 */
export function cosMediaUrl(key: string, download = false): string {
  const sp = new URLSearchParams({ key });
  if (download) sp.set("download", "true");
  return `${CONVERSATIONS_API_BASE}/media?${sp}`;
}

/** 取消进行中的声纹录入（幂等，关闭录入对话框时调用） */
export async function cancelVoiceEnroll(deviceSn: string): Promise<void> {
  const res = await fetch("/api/agent/voice/enroll/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "取消声纹录入失败");
  }
}

/** 记忆条目（B/A 类同构；B 类 key 非空，A 类 key 为空） */
export interface MemoryItem {
  id: number;
  key: string | null;
  value: string | null;
  is_extremum: boolean;
  content: string;        // 已把 {person_id} 渲染成名字
  content_raw: string;    // 库里原文（占位符形式），排查用
  mem_type: string;       // personal | household
  subjects: { person_id: string; name: string }[];
  speaker: string | null;
  session_id: number;
  status: string;         // active | superseded
  superseded_by: number | null;
  due_at: string | null;  // 仅 schedule kind
  created_at: string | null;
}

/** key 注册表节点元数据（树节点的中文名与 kind 标签） */
export interface MemoryKeyMeta {
  name: string;
  kind: string;           // state | event | schedule
}

export interface MemoryBTreeData {
  enabled: boolean;
  items: MemoryItem[];
  key_meta: Record<string, MemoryKeyMeta>;
}

export interface MemoryAPage {
  enabled: boolean;
  items: MemoryItem[];
  total: number;
  page: number;
  page_size: number;
}

/** B 类记忆全量（每家条数有界），树由前端按 key 点分路径构建 */
export async function fetchMemoryBTree(
  deviceSn: string, includeSuperseded: boolean,
): Promise<MemoryBTreeData> {
  const sp = new URLSearchParams({ device_sn: deviceSn });
  if (includeSuperseded) sp.set("include_superseded", "true");
  const res = await fetch(`/api/agent/memory/b_tree?${sp}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch B memories");
  }
  return res.json();
}

/** A 类记忆分页（最新在前；A 类随对话量线性增长，不全量拉取） */
export async function fetchMemoryAItems(
  deviceSn: string, page: number, pageSize: number,
): Promise<MemoryAPage> {
  const sp = new URLSearchParams({
    device_sn: deviceSn, page: String(page), page_size: String(pageSize),
  });
  const res = await fetch(`/api/agent/memory/a_items?${sp}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch A memories");
  }
  return res.json();
}

/** 整设备记忆清空结果 */
export interface DeviceMemoryEraseResult {
  ok: boolean;
  deleted_items: number;
  deleted_ingest_runs: number;
  message: string;
}

/** 清空一个设备（家庭）的全部记忆：条目 + 主体索引 + 抽取运行日志，物理删除
 *  不可恢复。花名册不动（删成员走花名册接口，有人脸底库联动）。 */
export async function eraseDeviceMemory(
  deviceSn: string,
): Promise<DeviceMemoryEraseResult> {
  const res = await fetch("/api/agent/memory/erase/device", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "清空设备记忆失败");
  }
  return res.json();
}

/** 整设备用户数据清空结果（花名册成员 + 底库人脸 + 记忆） */
export interface UserDataEraseResult {
  ok: boolean;
  deleted_members: number;
  faces_deleted: number;
  deleted_memory_items: number;
  deleted_ingest_runs: number;
  message: string;
}

/** 清空一个设备（家庭）的全部用户数据：花名册全部成员（联动删除 person_id
 *  底库人脸与声纹模板）+ 全部记忆（条目 + 主体索引 + 抽取运行日志），物理
 *  删除不可恢复。历史对话（会话与消息记录）保留。 */
export async function eraseUserData(
  deviceSn: string,
): Promise<UserDataEraseResult> {
  const res = await fetch("/api/agent/user_data/erase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "清空用户数据失败");
  }
  return res.json();
}

/** 按人记忆清除结果（shared_items：其中与他人共享、被一并删除的条数） */
export interface PersonMemoryEraseResult {
  ok: boolean;
  deleted_items: number;
  shared_items: number;
  message: string;
}

/** 清除一个人的全部记忆条目（含共享条目整条删），物理删除不可恢复。
 *  personId 传 "family" 可清除「我们家/全家」的家庭整体条目。 */
export async function erasePersonMemory(
  deviceSn: string, personId: string,
): Promise<PersonMemoryEraseResult> {
  const res = await fetch("/api/agent/memory/erase/person", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn, person_id: personId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "清除人物记忆失败");
  }
  return res.json();
}

/** 删除单条记忆。条目在变更历史链上（被别的记忆引用）时后端 409 拒绝，
 *  错误信息里带引用者 id。 */
export async function eraseMemoryItem(
  deviceSn: string, memoryId: number,
): Promise<{ ok: boolean; message: string }> {
  const res = await fetch("/api/agent/memory/erase/item", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn, memory_id: memoryId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "删除记忆失败");
  }
  return res.json();
}

/** 抽取运行日志里的一轮输入（speaker 已渲染成展示名，speaker_id 保留供排查） */
export interface IngestTurn {
  turn_id: string;
  speaker_id: string | null;
  speaker: string;
  text: string;
  is_robot: boolean;
  /** 全链路追踪号，与对话记录 Turn.trace_id 对应（旧数据/未传时为空） */
  trace_id?: string | null;
}

/** 护栏后的记忆草稿（content 已渲染成名字，content_raw 是库里原文） */
export interface IngestDraft {
  from_turn: string | number | null;
  content: string;
  content_raw: string;
  mem_type: string;
  subjects: { person_id: string; name: string }[];
  tag: { key: string; value: string; is_extremum: boolean; negate: boolean } | null;
}

/** 一次记忆抽取+应用运行（一次 flush 批处理 = 一行，行内自带完整过程快照） */
export interface MemoryIngestRun {
  id: number;
  session_id: number;
  trigger: string;        // batch_full | idle_timeout | shutdown
  status: string;         // ok | empty | error
  error: string | null;
  model_count: number;    // 模型给出条数（护栏前）
  draft_count: number;    // 护栏后条数
  stats: Record<string, number> | null;  // apply_drafts 写入统计
  extract_ms: number;
  apply_ms: number;
  created_at: string | null;
  new_turns: IngestTurn[];
  context_turns: IngestTurn[];
  llm_raw: string | null;
  drafts: IngestDraft[];
}

export interface MemoryIngestRunPage {
  enabled: boolean;
  items: MemoryIngestRun[];
  total: number;
  page: number;
  page_size: number;
}

/** 抽取运行日志分页（最新在前；行内含全部细节，点开无需二次请求）。
 * traceId 给定时只返回抽取源包含该轮的运行（配 sessionId 缩小命中，不分页）。 */
export async function fetchMemoryIngestRuns(
  deviceSn: string, page: number, pageSize: number,
  opts?: { sessionId?: number; traceId?: string },
): Promise<MemoryIngestRunPage> {
  const sp = new URLSearchParams({
    device_sn: deviceSn, page: String(page), page_size: String(pageSize),
  });
  if (opts?.sessionId != null) sp.set("session_id", String(opts.sessionId));
  if (opts?.traceId) sp.set("trace_id", opts.traceId);
  const res = await fetch(`/api/agent/memory/ingest_runs?${sp}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch memory ingest runs");
  }
  return res.json();
}

/** 一轮记忆摄取兜底扫描的水位采样（字段口径见后端 MemorySweepSampleORM）。
 *  容量模型：稳态要求 R·t < C，等价于「排空耗时 < 扫描周期」（水位 < 1）。 */
export interface SweepSample {
  id: number;
  created_at: string | null;
  instance_id: string;      // 当时持扫描租约的实例，换人说明发生过接管
  devices: number;          // 已跟踪设备数
  candidates: number;       // 批量预筛后剩下的候选数
  planned: number;          // 规划出批的设备数
  batches: number;          // 真派出的批数 = N
  prefilter_ms: number;
  plan_ms: number;          // 含预筛，派完即止（不含抽取）
  drain_ms: number | null;  // = D；null 表示没排空就被下一轮换了代
  inflight_left: number;    // 换代时仍在途的批数，> 0 即超载
  t_mean_ms: number | null; // 本轮单批服务耗时 = t（排队时间不计，归 D）
  t_max_ms: number | null;
  t_count: number;
  concurrency: number;      // = C（当时生效值）
  interval_sec: number;     // = I（当时生效值）
}

/** 最近 N 小时的扫描水位采样，按时间正序（全局，不分设备）。 */
export async function fetchSweepSamples(
  hours: number,
): Promise<{ enabled: boolean; hours?: number; items: SweepSample[] }> {
  const res = await fetch(`/api/agent/memory/sweep_samples?hours=${hours}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch sweep samples");
  }
  return res.json();
}

/** 一个上游一分钟的访问计数（后端 Redis 分钟桶，所有 voice 实例全局累加）。
 *  各上游只有自己注册过的口径（见后端 traffic_metrics.PROVIDERS），
 *  没有的字段缺省。 */
export interface TrafficMinuteSample {
  /** 分钟起点（naive 产品时区，如 "2026-08-05 17:03:00"） */
  minute: string;
  /** 建连次数（TTS/ASR 类上游：每次合成/识别新建一条连接）；agent_chat 无此口径 */
  connects?: number;
  /** 请求次数：minimax 的 task_continue / azure 的逐句合成 /
   *  ASR 每轮识别会话 / HTTP 请求 */
  requests?: number;
  /** 失败次数：建连失败 + 服务端错误事件 + 请求异常（多为静默降级，
   *  这条线是唯一暴露口） */
  errors?: number;
}

/** 一个上游最近 N 分钟的逐分钟访问次数（时间正序，空分钟补 0；
 *  最后一个元素是当前尚未走完的分钟，读数会继续涨）。
 *  provider ∈ minimax_tts | azure_tts | xiaodu_asr | azure_asr | volcengine_asr | agent_chat。 */
export async function fetchTrafficMetrics(
  provider: string,
  minutes: number,
): Promise<{ provider: string; minutes: number; items: TrafficMinuteSample[] }> {
  const res = await fetch(
    `/api/voice/traffic/${encodeURIComponent(provider)}?minutes=${minutes}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch traffic metrics");
  }
  return res.json();
}

/** 一个会话中已进入过抽取批次的轮次 trace_id 集合（轮次行「已抽取/未抽取」标记用） */
export async function fetchExtractedTraces(
  deviceSn: string, sessionId: number,
): Promise<{ enabled: boolean; trace_ids: string[] }> {
  const sp = new URLSearchParams({
    device_sn: deviceSn, session_id: String(sessionId),
  });
  const res = await fetch(`/api/agent/memory/extracted_traces?${sp}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch extracted traces");
  }
  return res.json();
}

/** 后端配置查询接口的统一响应（voice / agent / console 同构） */
export interface ServiceConfig {
  service: string;
  version: string;
  env: string;
  /** 本进程最近一次启动时刻（naive 北京时间，如 "2026-08-04 20:09:15"） */
  started_at?: string | null;
  /** 本进程可达 IP（bind 为 0.0.0.0 时为探测到的出口 IP；GPU 服务为 deploy host） */
  host?: string | null;
  /** 本进程监听端口 */
  port?: number | null;
  /** 本进程依赖的内部 packages 版本（如 common / session_store / family_memory） */
  packages?: Record<string, string>;
  config: Record<string, unknown>;
}

export async function fetchVoiceConfig(): Promise<ServiceConfig> {
  const res = await fetch("/api/voice/config");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch voice_server config");
  }
  return res.json();
}

export async function fetchAgentConfig(): Promise<ServiceConfig> {
  const res = await fetch("/api/agent/config");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch agent_server config");
  }
  return res.json();
}

export async function fetchConsoleConfig(): Promise<ServiceConfig> {
  const res = await fetch("/api/console/config");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch console_server config");
  }
  return res.json();
}

/** person_id 服务经 /person_id 前缀代理直达（同视觉页的 REST 规则）。
    滑块调参接口已改名 /api/params，/api/config 与 voice/agent 一样返回全量脱敏 dump。 */
export async function fetchPersonConfig(): Promise<ServiceConfig> {
  const res = await fetch("/person_id/api/config");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch person_id config");
  }
  return res.json();
}

/* ── 拉流并发监控（person_id 同时开着多少路人脸识别视频流，「流量监控」页）── */

/** 一路服务端拉流的快照（person_id StreamListItem，只声明 web 读取的字段） */
export interface StreamListItem {
  camera_id: string;
  running: boolean;
  /** 是否真正连上视频流（running 但没 connected = 设备没推流 / 重连中） */
  connected: boolean;
  /** 这路流实际使用的 ISS 地址 */
  iss_api_url: string;
  /** 本次 start 的时刻（epoch 秒） */
  started_at: number | null;
  /** 发起入口，如 "consume/start 接口(lease_seconds=60) <- voice_server/wake_keeper:start(trigger=wake)"
   *  或 "启动恢复(Redis 期望状态)"；"<- " 之后是上游自报的 X-Request-Source */
  start_source: string | null;
  /** 租约到期时刻（epoch 秒）；null = 永久（控制台手动开的） */
  lease_deadline: number | null;
  viewers: number;
  process_fps: number;
  stream_width: number;
  stream_height: number;
  /** 自动重推流恢复进行中 */
  recovering: boolean;
  restream_count: number;
  last_error: string | null;
}

export interface StreamListData {
  /** 正在消费的路数 */
  running: number;
  /** 其中已连上视频流的路数 */
  connected: number;
  items: StreamListItem[];
}

export async function fetchStreamList(): Promise<StreamListData> {
  const res = await fetch("/person_id/api/streams");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/** 一分钟的拉流并发统计（person_id Redis 分钟桶） */
export interface StreamConcurrencySample {
  /** 分钟起点（naive 产品时区，如 "2026-09-07 10:03:00"） */
  minute: string;
  /** 该分钟内同时在消费的最大路数 */
  peak_running: number;
  /** 其中已连上视频流的最大路数 */
  peak_connected: number;
  /** 消费器登记 / 注销次数（唤醒联动反复开关、URL 变更停旧起新都算） */
  starts: number;
  stops: number;
}

/** 最近 N 分钟逐分钟并发统计（时间正序，缺桶补 0；末元素是当前未走完的分钟，
 *  峰值最多落后一个采样周期 5s，启停计数还会涨）。 */
export async function fetchStreamConcurrency(
  minutes: number,
): Promise<{ minutes: number; items: StreamConcurrencySample[] }> {
  const res = await fetch(`/person_id/api/streams/concurrency?minutes=${minutes}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ── 拉流录像（person_id 自动录制 → COS）── */

export interface VideoRecordingItem {
  id: number;
  device_sn: string;
  stream_session_id: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  width: number;
  height: number;
  fps: number;
  frame_count: number;
  cos_key: string | null;
  status: string;
  error_message: string | null;
}

export async function fetchVideoList(params: {
  start_from?: string;
  start_to?: string;
  device_sn?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<VideoRecordingItem[]> {
  const sp = new URLSearchParams();
  if (params.start_from) sp.set("start_from", params.start_from);
  if (params.start_to) sp.set("start_to", params.start_to);
  if (params.device_sn) sp.set("device_sn", params.device_sn);
  if (params.status !== undefined) sp.set("status", params.status);
  if (params.limit != null) sp.set("limit", String(params.limit));
  if (params.offset != null) sp.set("offset", String(params.offset));
  const res = await fetch(`/person_id/api/videos?${sp}`);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`获取录像列表失败: ${detail}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

/** 预览/下载：经 person_id 307 跳转到 COS 临时链 */
export function videoMediaUrl(videoId: number, download = false): string {
  const sp = new URLSearchParams();
  if (download) sp.set("download", "true");
  const q = sp.toString();
  return `/person_id/api/videos/${videoId}/media${q ? `?${q}` : ""}`;
}

export async function deleteVideo(videoId: number): Promise<void> {
  const res = await fetch(`/person_id/api/videos/${videoId}`, { method: "DELETE" });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`删除录像失败: ${detail}`);
  }
}

/** 记忆 GPU 服务（嵌入/key 抽取）经 nginx 前缀代理直达，/api/config 与
    voice/agent 同构（service/version/env/started_at/脱敏 config dump）。 */
export async function fetchEmbeddingConfig(): Promise<ServiceConfig> {
  const res = await fetch("/embedding/api/config");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch embedding-service config");
  }
  return res.json();
}

export async function fetchKeyExtractorConfig(): Promise<ServiceConfig> {
  const res = await fetch("/key_extractor/api/config");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch key-extractor config");
  }
  return res.json();
}

/* ── 配置在线编辑（DB 覆盖层）──
   编辑后的值存数据库，删除覆盖即恢复 yaml 原值。全部叶子配置可编辑
   （锁定项除外），编辑需口令（X-Config-Edit-Password 头，后端校验）。 */

export type ConfigService = "voice" | "agent" | "console" | "person";

const CONFIG_EDIT_PREFIX: Record<ConfigService, string> = {
  voice: "/api/voice/config/editable",
  agent: "/api/agent/config/editable",
  console: "/api/console/config/editable",
  person: "/person_id/api/config/editable",
};

/** 带 HTTP 状态码的错误（口令错误 401 需要单独识别以重新弹口令框） */
export interface HttpError extends Error {
  status?: number;
}

async function throwHttpError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  const err = new Error(data.detail || fallback) as HttpError;
  err.status = res.status;
  throw err;
}

/** 一个可在线编辑的配置项及其当前状态 */
export interface EditableField {
  path: string;          // 配置点路径，如 llm.model / prompt.small_talk
  value: unknown;        // 当前生效值（敏感字段为 "***"）
  baseline: unknown;     // yaml 原值（删除覆盖后会恢复成它；敏感字段为 "***"）
  overridden: boolean;   // 是否被数据库覆盖过
  hot: boolean;          // true=改完立即生效; false=需重启服务（未标注的字段保守按 false）
  description: string;   // 中文说明（未标注的字段为空串）
  sensitive: boolean;    // 敏感字段（密钥/密码类）：可编辑但值不回显
  device_override_count: number;  // 有多少台设备对此项做了设备级定向覆盖
}

export interface EditableConfig {
  service: string;
  items: EditableField[];
}

export interface OverrideMutationResult {
  path: string;
  value: unknown;        // 生效后的值（删除时即恢复出的原值；敏感字段为 "***"）
  overridden: boolean;
  need_restart: boolean;
}

export async function fetchEditableConfig(service: ConfigService): Promise<EditableConfig> {
  const res = await fetch(CONFIG_EDIT_PREFIX[service]);
  if (!res.ok) await throwHttpError(res, `Failed to fetch ${service} editable config`);
  return res.json();
}

export async function putConfigOverride(
  service: ConfigService, path: string, value: unknown, password: string,
): Promise<OverrideMutationResult> {
  const res = await fetch(`${CONFIG_EDIT_PREFIX[service]}/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Config-Edit-Password": password },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) await throwHttpError(res, "保存配置失败");
  return res.json();
}

export async function deleteConfigOverride(
  service: ConfigService, path: string, password: string,
): Promise<OverrideMutationResult> {
  const res = await fetch(`${CONFIG_EDIT_PREFIX[service]}/${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: { "X-Config-Edit-Password": password },
  });
  if (!res.ok) await throwHttpError(res, "恢复默认值失败");
  return res.json();
}

/* ── 设备级配置覆盖 ──
   只对指定 device_sn 生效的定向配置修改，其他设备不受影响。
   可编辑范围 = hot（热生效）标注字段；优先级：设备覆盖 > 全局覆盖 > yaml 原值，
   删除设备覆盖即回落到全局生效值。 */

const CONFIG_DEVICE_PREFIX: Record<ConfigService, string> = {
  voice: "/api/voice/config/devices",
  agent: "/api/agent/config/devices",
  // console / person_id 没有按设备解析配置的消费链路，后端不开放任何设备级
  // 字段；端点存在但恒为空，设备覆盖面板也不查询它们
  console: "/api/console/config/devices",
  person: "/person_id/api/config/devices",
};

/** 设备视角的一个可编辑配置项。值来源三层：设备覆盖 → 全局生效值 → yaml 原值 */
export interface DeviceEditableField {
  path: string;
  value: unknown;         // 该设备的生效值（有设备覆盖用覆盖值；敏感字段为 "***"）
  global_value: unknown;  // 全局生效值（含全局在线编辑覆盖；敏感字段为 "***"）
  baseline: unknown;      // yaml 原值（敏感字段为 "***"）
  overridden: boolean;    // 该设备是否对此项做了定向覆盖
  description: string;
  sensitive: boolean;
}

export interface DeviceEditableConfig {
  service: string;
  device_sn: string;
  items: DeviceEditableField[];
}

/** 一台有设备级覆盖的设备（防遗忘总览用）。name 为空时展示 device_sn */
export interface DeviceOverrideSummaryItem {
  device_sn: string;
  name: string;
  override_count: number;
}

export interface DeviceOverrideSummary {
  service: string;
  devices: DeviceOverrideSummaryItem[];
}

export async function fetchDeviceOverrideSummary(service: ConfigService): Promise<DeviceOverrideSummary> {
  const res = await fetch(CONFIG_DEVICE_PREFIX[service]);
  if (!res.ok) await throwHttpError(res, `Failed to fetch ${service} device override summary`);
  return res.json();
}

export async function fetchDeviceEditableConfig(
  service: ConfigService, deviceSn: string,
): Promise<DeviceEditableConfig> {
  const res = await fetch(`${CONFIG_DEVICE_PREFIX[service]}/${encodeURIComponent(deviceSn)}/editable`);
  if (!res.ok) await throwHttpError(res, `Failed to fetch ${service} device editable config`);
  return res.json();
}

export async function putDeviceConfigOverride(
  service: ConfigService, deviceSn: string, path: string, value: unknown, password: string,
): Promise<OverrideMutationResult> {
  const res = await fetch(
    `${CONFIG_DEVICE_PREFIX[service]}/${encodeURIComponent(deviceSn)}/editable/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Config-Edit-Password": password },
      body: JSON.stringify({ value }),
    },
  );
  if (!res.ok) await throwHttpError(res, "保存设备覆盖失败");
  return res.json();
}

export async function deleteDeviceConfigOverride(
  service: ConfigService, deviceSn: string, path: string, password: string,
): Promise<OverrideMutationResult> {
  const res = await fetch(
    `${CONFIG_DEVICE_PREFIX[service]}/${encodeURIComponent(deviceSn)}/editable/${encodeURIComponent(path)}`,
    {
      method: "DELETE",
      headers: { "X-Config-Edit-Password": password },
    },
  );
  if (!res.ok) await throwHttpError(res, "删除设备覆盖失败");
  return res.json();
}

/** 提示词模板里会被程序替换的一个占位符 */
export interface PromptPlaceholder {
  name: string;   // 含花括号, 如 {memory}
  note: string;   // 注入什么、什么时机注入
}

/** 一个 LLM 提示词模板的元信息与原文（GET /api/agent/prompts） */
export interface PromptTemplateInfo {
  key: string;
  title: string;
  usage: string;
  source: string;              // 来源文件（仓库相对路径）
  source_kind: string;         // yaml=改配置即可调整 | code=写死在代码里
  /** 配置模型里的真实叶子路径（在线编辑用它定位）；code 来源为 null */
  config_path: string | null;
  model: string | null;        // 使用该提示词的 LLM 模型名（未接入为 null）
  placeholders: PromptPlaceholder[];
  template: string;            // 模板原文（占位符未填充）
  /** 启动时一次性渲染后的实际提示词（仅码表类静态占位符的模板有） */
  rendered: string | null;
}

/** deviceSn 非空时返回该设备视角的生效模板（叠加其设备级覆盖），空串即全局生效值 */
export async function fetchPrompts(deviceSn = ""): Promise<PromptTemplateInfo[]> {
  const qs = deviceSn ? `?${new URLSearchParams({ device_sn: deviceSn })}` : "";
  const res = await fetch(`/api/agent/prompts${qs}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch prompts");
  }
  const data = await res.json();
  return data.prompts ?? [];
}

/** 风控在线测试结果（POST /api/voice/moderation/test，与生产守卫同一套审核函数） */
export interface ModerationTestResult {
  /** 风控总开关当前状态（测试接口不受它限制，关着也能测） */
  enabled: boolean;
  rule: {
    hit: boolean;
    /** 命中的正则原文；未命中为 null */
    pattern: string | null;
    rule_count: number;
  };
  llm: {
    /** 是否实际调用了风控模型（未配置 moderation.llm 时为 false） */
    checked: boolean;
    model: string | null;
    /** 模型是否判有风险（调用失败按无风险，同生产 fail-open） */
    risky: boolean;
    replacement: string | null;
    /** 模型原始输出（协议：首字符 0/1）。无风险时因首 token 即断流只有开头的包 */
    raw_output: string | null;
    /** 首 token 延迟（毫秒），即拿到风险结论的时间 */
    ttft_ms: number | null;
    /** 总耗时（毫秒）：无风险≈首token即返回；有风险还含收完替代话术的时间 */
    elapsed_ms: number | null;
    /** 调用失败原因（生产会按无风险放行）；正常为 null */
    error: string | null;
  };
  final: {
    /** 综合结论：任一层命中即有风险 */
    risky: boolean;
    source: string | null;
    /** 实际会播报并写入对话历史的替代话术 */
    replacement: string | null;
  };
}

export async function testModeration(
  replyText: string,
  query: string,
  /** 最近几轮对话（可空）。生产送审自动附带，格式为每行“用户: …”或“机器人: …” */
  history = "",
  deviceSn = "",
): Promise<ModerationTestResult> {
  const res = await fetch("/api/voice/moderation/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply_text: replyText, query, history, device_sn: deviceSn }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "风控测试请求失败");
  }
  return res.json();
}

/** 设备实时状态（GET /api/agent/device/status，与「电量查询」意图同一条 Redis 读取链路） */
export interface DeviceStatusResult {
  /** Redis 里是否有该设备的状态数据（查询失败也算 false，原因见 agent_server 日志） */
  found: boolean;
  device_sn: string;
  status: {
    signal_strength: number;
    is_wifi_connected: boolean;
    battery: number;
    work_mode: string;
    work_type: string;
    is_charging: boolean;
    ip: string;
    wifi_ssid: string;
    /** 后端字段名 iccid_4g，序列化按 alias 还原为 Redis 原键名 */
    "4g_iccid": string;
    is_bluetooth_controller_connected: boolean;
    is_joint_enable_mini: boolean;
    /** 机器人是否在车上；老固件不上报该字段时为 null */
    is_on_car: boolean | null;
    /** 设备音量 0-100；老固件不上报该字段时为 null */
    volume: number | null;
    robot_position_x: number;
    robot_position_y: number;
    robot_towards: number;
    app_update_timestamp: number;
    status_report_order_ts: number;
  } | null;
  /** Redis hash 原始键值（含 status 未收录的字段）；不存在或读取失败为 null。
   *  found=false 而 raw 非空说明是模型解析失败而非数据缺失 */
  raw: Record<string, string> | null;
}

export async function fetchDeviceStatus(deviceSn: string): Promise<DeviceStatusResult> {
  const res = await fetch(
    `/api/agent/device/status?device_sn=${encodeURIComponent(deviceSn)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "查询设备状态失败");
  }
  return res.json();
}

/** ASR 测试面板用的配置摘要（GET /api/voice/asr/test/config） */
export interface AsrTestConfig {
  /** 生产当前使用的 ASR 提供商（asr.name）；测试的 provider 按次可选，不必等于它 */
  provider: string;
  /** 支持在线测试的提供商 */
  test_providers: string[];
  volcengine: {
    /** asr.volcengine.api_key 是否已配置 */
    configured: boolean;
    /** asr.volcengine.mode 当前配置值（不选模式时用它） */
    default_mode: string;
    modes: string[];
    resource_id: string;
  };
  xiaodu: {
    /** asr.xiaodu 的 appid/appkey/endpoint 是否已配置 */
    configured: boolean;
    endpoint: string;
    /** 识别模型 dev_pid */
    pid: string;
  };
  /** 当前生效的热词（识别请求会直传） */
  hot_words: string[];
  /** 生产输入采样率（上传音频会转换到该采样率） */
  input_sample_rate: number;
}

export async function fetchAsrTestConfig(): Promise<AsrTestConfig> {
  const res = await fetch("/api/voice/asr/test/config");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "获取 ASR 测试配置失败");
  }
  return res.json();
}

/** ASR 在线测试结果（POST /api/voice/asr/test，走生产同款 ASR 客户端） */
export interface AsrTestResult {
  /** 本次实际测试的 ASR 提供商 */
  provider: string;
  /** 本次实际使用的识别模式（仅火山引擎，其余为 null） */
  mode: string | null;
  /** 是否按 200ms 实时节奏喂入（模拟生产时序） */
  realtime: boolean;
  filename: string;
  /** 转换后音频时长（秒） */
  audio_seconds: number;
  /** 最终识别文本；无有效语音或等待超时为 null */
  text: string | null;
  /** 发送负包到拿到最终结果的耗时（毫秒），realtime 时才有生产参考意义 */
  latency_ms: number;
  /** 建连+喂音频+等结果的总耗时（毫秒） */
  elapsed_ms: number;
  /** 中间识别结果（bigmodel_nostream 模式没有） */
  mid_texts: { t_ms: number; text: string }[];
}

export async function testAsr(
  file: File,
  /** volcengine / xiaodu；空 = 跟随当前配置 asr.name */
  provider = "",
  /** 仅火山引擎有效；空 = 用当前配置 asr.volcengine.mode */
  mode = "",
  realtime = false,
): Promise<AsrTestResult> {
  const fd = new FormData();
  fd.append("file", file);
  if (provider) fd.append("provider", provider);
  if (mode) fd.append("mode", mode);
  fd.append("realtime", String(realtime));
  const res = await fetch("/api/voice/asr/test", { method: "POST", body: fd });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "ASR 测试请求失败");
  }
  return res.json();
}

// ── VAD 触发调参（POST /api/voice/vad/test|tune，纯离线仿真不触发对话） ──

/** VAD 调参面板配置摘要（GET /api/voice/vad/test/config） */
export interface VadTestConfig {
  /** 当前生效的完整仿真参数（vad.* 配置 + AGC 内部参数缺省值） */
  current: Record<string, number | boolean>;
  /** 可调参数清单（key → {default}） */
  tunable: Record<string, { default: number | boolean }>;
  /** 寻优默认扫描网格 */
  default_grid: Record<string, number[]>;
  /** 打分公式说明 */
  scoring: string;
  limits: {
    max_files: number;
    max_test_seconds: number;
    max_tune_seconds: number;
    max_combos: number;
  };
  input_sample_rate: number;
}

export interface VadFileStats {
  peak_db: number;
  noise_floor_db: number;
  speech_db: number;
  snr_db: number;
}

/** 单个文件的触发分析结果 */
export interface VadFileResult {
  filename: string;
  /** 标注: speech / noise / unknown */
  expect: string;
  audio_seconds: number;
  stats: VadFileStats;
  /** 触发段 [start_s, end_s] 列表 */
  segments: number[][];
  /** ok / miss / false_trigger / n_a */
  verdict: string;
  /** 末段结束到音频结尾的时长（speech 文件的尾部拖延），无触发为 null */
  tail_seconds: number | null;
  /** 回放结束时的增益（AGC 收敛值或固定值） */
  final_gain_db: number;
  /** 增益轨迹 [t_s, gain_db]，每秒一点 */
  gain_track: number[][];
}

/** 按标注汇总的指标与得分 */
export interface VadSummary {
  speech_detected: number;
  speech_total: number;
  noise_rejected: number;
  noise_total: number;
  tail_mean_s: number;
  extra_segments: number;
  score: number;
}

export interface VadTestResult {
  params: Record<string, number | boolean>;
  files: VadFileResult[];
  summary: VadSummary;
}

export interface VadComboResult {
  /** 与当前配置不同的参数（空对象=就是当前配置） */
  overrides: Record<string, number | boolean>;
  metrics: VadSummary;
}

export interface VadTuneResult {
  n_files: number;
  audio_seconds: number;
  n_combos: number;
  scoring: string;
  /** 当前生效配置的表现（对照基准） */
  baseline: VadComboResult;
  /** 按 score 降序的 top 组合 */
  results: VadComboResult[];
  /** 最优组合下每个文件的触发详情 */
  best_files: VadFileResult[];
}

export async function fetchVadTestConfig(): Promise<VadTestConfig> {
  const res = await fetch("/api/voice/vad/test/config");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "获取 VAD 调参配置失败");
  }
  return res.json();
}

function vadFormData(
  items: { file: File; expect: string }[],
  deviceSn: string,
): FormData {
  const fd = new FormData();
  for (const it of items) fd.append("files", it.file);
  fd.append("expects", items.map((it) => it.expect).join(","));
  if (deviceSn) fd.append("device_sn", deviceSn);
  return fd;
}

/** 触发分析：按指定参数（空=当前配置）离线回放上传的音频 */
export async function testVad(
  items: { file: File; expect: string }[],
  /** 参数覆盖 JSON 字符串，如 '{"threshold":0.8}'；空=当前配置 */
  params: string,
  deviceSn = "",
): Promise<VadTestResult> {
  const fd = vadFormData(items, deviceSn);
  if (params.trim()) fd.append("params", params.trim());
  const res = await fetch("/api/voice/vad/test", { method: "POST", body: fd });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "VAD 触发分析请求失败");
  }
  return res.json();
}

/** 参数寻优：网格扫描找最优参数组合（可能需要几十秒到几分钟） */
export async function tuneVad(
  items: { file: File; expect: string }[],
  /** 扫描网格 JSON 字符串；空=默认网格 */
  grid: string,
  topN = 10,
  deviceSn = "",
): Promise<VadTuneResult> {
  const fd = vadFormData(items, deviceSn);
  if (grid.trim()) fd.append("grid", grid.trim());
  fd.append("top_n", String(topN));
  const res = await fetch("/api/voice/vad/tune", { method: "POST", body: fd });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "VAD 参数寻优请求失败");
  }
  return res.json();
}

export async function sendAction(
  device_sn: string,
  device_type_id: string,
  action_id: number
): Promise<void> {
  const res = await fetch("/api/voice/action/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn, device_type_id, action_id }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to send action");
  }
}

/** 设备搜索结果的一条（name 为空串表示未命名） */
export interface DeviceSearchItem {
  device_sn: string;
  name: string;
}

/** 按设备显示名称（含改名后的新名称）或 device_sn 模糊搜索设备 */
export async function searchDevices(q: string, limit = 20): Promise<DeviceSearchItem[]> {
  const sp = new URLSearchParams({ q, limit: String(limit) });
  const res = await fetch(`/api/voice/device/search?${sp}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to search devices");
  }
  const data = await res.json();
  return data.items ?? [];
}

/** 设置设备显示名称（空串清除）。名称是设备档案属性，同设备所有会话共用 */
export async function updateDeviceName(
  deviceSn: string,
  name: string
): Promise<void> {
  const res = await fetch(
    `/api/voice/device/${encodeURIComponent(deviceSn)}/name`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to update device name");
  }
}

export async function sendMqttCommand(
  device_sn: string,
  device_type_id: string,
  payload: object
): Promise<void> {
  const res = await fetch("/api/voice/device/cmd/mqtt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn, device_type_id, payload }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to send MQTT command");
  }
}

/** 一句话任务单轮解析（POST /api/agent/task/parse，agent_server oneshot_task/parse 子包，App 同款接口）。
 *  专用 LLM 抽取时间/地点/人物/播报文案，不追问；地点与人物是可选要素。 */
export interface TaskParseExecutionTime {
  /** 生效起始日 YYYY-MM-DD；单次任务 start==end，长期重复截止 2099-01-01 */
  start_date: string;
  end_date: string;
  hour: number;
  minute: number;
  /** 重复星期：1=周一…7=周日；每天=[1..7]；空数组=单次 */
  week_days: number[];
}

/** 任务类型：请求 type 与模板 task_type 同一套取值；checkin=打卡（模板 enable_photo=true） */
export type TaskType = "ordinary" | "checkin";

export interface TaskParseTemplate {
  name: string;
  /** 与请求 type 一致 */
  task_type: string;
  execution_time: TaskParseExecutionTime;
  /** 目标人物；未提及为 null。「提醒我」→ name「我」、「全家人/大家」→ name「大家」（id 均空串，
   *  文本接口没有说话人身份）；id 空串且其他称呼=提到了人但花名册未命中（name 为句中原称呼） */
  target_person: { id: string; name: string } | null;
  /** 执行地点；未指定为 null */
  location: { name: string } | null;
  content: { tts_text: string };
  enable_photo: boolean;
}

/** data 二选一：抽出任务只有 template；没听懂只有 message（哪里没听清）+ suggestion（可照着说的示例） */
export type TaskParseData =
  | { recognized: true; template: TaskParseTemplate }
  | { recognized: false; message: string; suggestion: string };

export interface TaskParseResponse {
  /** 0=正常（含「没听懂」recognized=false）；500=解析服务异常（LLM 调用失败，msg 带原因） */
  code: number;
  msg: string;
  data: TaskParseData;
}

export async function parseOneshotTask(
  text: string,
  taskType: TaskType = "ordinary",
  /** 可选；带上才会把目标人物经花名册消解出 person_id（一设备一家庭） */
  deviceSn = "",
): Promise<TaskParseResponse> {
  const body: Record<string, unknown> = { text, type: taskType };
  if (deviceSn) body.deviceSn = deviceSn;
  const res = await fetch("/api/agent/task/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "一句话任务解析请求失败");
  }
  return res.json();
}
