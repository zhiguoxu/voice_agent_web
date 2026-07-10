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
  user_id: string;
  device_type_id: string;
  location: string | null;
  created_at: string | null;
  last_active_at: string | null;
  first_turn_at: string | null;
  last_turn_at: string | null;
  is_online: boolean;
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
  t_llm_tool_start: number | null;
  t_llm_tool_done: number | null;
  t_tool_execute_start: number | null;
  t_tool_execute_done: number | null;
  tool_names: string | null;
  tool_arguments: string | null;
  tool_results: string | null;
  chat_request: { query: string; history: { role: string; content: string }[]; system_prompt: string | null; image_url: string | null; llm: { model: string; base_url: string } | null } | null;
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
// 与 voice_server 无关）
export async function fetchRoster(): Promise<RosterData> {
  const res = await fetch("/api/agent/roster");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to fetch roster");
  }
  return res.json();
}

export async function deleteRosterMember(personId: string): Promise<void> {
  const res = await fetch(`/api/agent/roster/${encodeURIComponent(personId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to delete roster member");
  }
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
