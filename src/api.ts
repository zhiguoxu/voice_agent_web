// 后端按前缀分流（vite dev proxy 与生产 nginx 同规则）：
//   /api/voice/*  → voice_server(:8017)，代理层去掉 /voice 前缀
//   /api/agent/*  → agent_server(:8018)，原样透传（agent_server 本身就是 /api/agent 前缀）
export const CONVERSATIONS_API_BASE = "/api/voice/conversations";
export const LOGS_API_BASE = "/api/voice/logs";

export interface LogEntry {
  seq?: number;
  source?: string;
  time: string;
  level: string;
  msg: string;
  device_sn: string;
  trace_id: string;
  file: string;
  module: string;
  function: string;
  line: number;
  name: string;
  /** 异常堆栈全文（仅 logger.exception 记录的日志携带） */
  exc?: string;
}

export async function fetchRecentLogs(
  params: { limit?: number; level?: string } = {}
): Promise<LogEntry[]> {
  const sp = new URLSearchParams();
  sp.set("limit", String(params.limit ?? 200));
  if (params.level) sp.set("level", params.level);
  const res = await fetch(`${LOGS_API_BASE}/recent?${sp}`);
  if (!res.ok) throw new Error("Failed to fetch recent logs");
  const data = await res.json();
  return data.items ?? [];
}

export async function clearBackendLogs(): Promise<void> {
  const res = await fetch(LOGS_API_BASE, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to clear backend logs");
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

export interface Turn {
  id: number;
  trace_id: string;
  query: string;
  speaker_id: string | null;
  speaker_name: string | null;
  reply_text: string | null;
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
  t_names_done: number | null;
  t_memory_done: number | null;
  t_stateless_start: number | null;
  t_bert_start: number | null;
  t_bert_done: number | null;
  bert_confidence: number | null;
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
  chat_request: { query: string; history: { role: string; content: string }[]; system_prompt: string | null; image_url: string | null; llm: { model: string; base_url: string } | null } | null;
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

export interface ReplayResult {
  reply_text: string;
  intent_source: string | null;
  intent_name: string | null;
  command_type: string | null;
  subagent_name: string | null;
  timing: {
    t_agent_start?: number | null;
    t_history_done?: number | null;
    t_identity_done?: number | null;
    t_names_done?: number | null;
    t_memory_done?: number | null;
    t_stateless_start?: number | null;
    t_bert_start?: number | null;
    t_bert_done?: number | null;
    bert_confidence?: number | null;
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

export async function testSessionInput(sessionId: number, text: string, withTts: boolean): Promise<void> {
  const res = await fetch(`${CONVERSATIONS_API_BASE}/sessions/${sessionId}/test_input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, with_tts: withTts }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Test input failed: ${detail}`);
  }
}

export async function forceNewSession(sessionId: number): Promise<{ new_session_id: number }> {
  const res = await fetch(`${CONVERSATIONS_API_BASE}/sessions/${sessionId}/force_new`, {
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

/** 删除花名册成员，同时联动删除 person_id 底库里此人的人脸（device_sn 定位底库） */
export async function deleteRosterMember(
  personId: string, deviceSn: string,
): Promise<void> {
  const res = await fetch(
    `/api/agent/roster/${encodeURIComponent(personId)}?device_sn=${encodeURIComponent(deviceSn)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to delete roster member");
  }
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
   *  问题) | stream_off | duplicate_name；探测失败(透传失败码): 3 轮均失败时
   *  透传最后一次 (camera_offline | no_target | no_face | low_face_quality
   *  等，兜底 enroll_failed)，服务调用失败则立即中止 (error | disabled)；
   *  其他: name_save_failed (人脸已入库但名字没写上，重试注册可自愈，
   *  person_id 有值) | internal_error */
  status: string;
  message: string;
  person_id: string | null;
}

/** 触发一次引导式人脸注册。同步接口：阻塞到流程结束（最多 3 轮 × 每轮 4 次
 *  带质量门槛的注册探测，通常几十秒），期间设备会语音引导用户；返回最终结果。 */
export async function registerFace(
  deviceSn: string, name: string,
): Promise<FaceRegisterResult> {
  const res = await fetch("/api/agent/face/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_sn: deviceSn, name }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "触发人脸注册失败");
  }
  return res.json();
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
  trigger: string;        // batch_full | idle_timeout | session_switch | shutdown
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

/** 后端配置查询接口的统一响应（voice_server / agent_server 同构） */
export interface ServiceConfig {
  service: string;
  version: string;
  env: string;
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

/* ── 配置在线编辑（DB 覆盖层）──
   编辑后的值存数据库，删除覆盖即恢复 yaml 原值。全部叶子配置可编辑
   （锁定项除外），编辑需口令（X-Config-Edit-Password 头，后端校验）。 */

export type ConfigService = "voice" | "agent";

const CONFIG_EDIT_PREFIX: Record<ConfigService, string> = {
  voice: "/api/voice/config/editable",
  agent: "/api/agent/config/editable",
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
  model: string | null;        // 使用该提示词的 LLM 模型名（未接入为 null）
  placeholders: PromptPlaceholder[];
  template: string;            // 模板原文（占位符未填充）
  /** 启动时一次性渲染后的实际提示词（仅码表类静态占位符的模板有） */
  rendered: string | null;
}

export async function fetchPrompts(): Promise<PromptTemplateInfo[]> {
  const res = await fetch("/api/agent/prompts");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch prompts");
  }
  const data = await res.json();
  return data.prompts ?? [];
}

/** BERT 意图分类的 label_map 与服务状态 */
export interface IntentLabels {
  labels: Record<string, string>;
  count: number;
  base_url: string;
  confidence_threshold: number;
  healthy: boolean;
}

export interface IntentClassifyResult {
  query: string;
  label: string;
  confidence: number;
  confidence_threshold: number;
  hit: boolean;
  final_intent: string;
}

export async function fetchIntentLabels(): Promise<IntentLabels> {
  const res = await fetch("/api/agent/intent/labels");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch intent labels");
  }
  return res.json();
}

export async function classifyIntent(text: string): Promise<IntentClassifyResult> {
  const res = await fetch("/api/agent/intent/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to classify intent");
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
