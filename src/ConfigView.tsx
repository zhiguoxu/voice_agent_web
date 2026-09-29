import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchVoiceConfig,
  fetchAgentConfig,
  fetchConsoleConfig,
  fetchPersonConfig,
  fetchMemoryConfig,
  fetchEditableConfig,
  putConfigOverride,
  deleteConfigOverride,
  fetchDeviceEditableConfig,
  putDeviceConfigOverride,
  deleteDeviceConfigOverride,
  fetchConfigGroups,
  createConfigGroup,
  deleteConfigGroup,
  fetchGroupEditableConfig,
  putGroupConfigOverride,
  deleteGroupConfigOverride,
  GROUP_SERVICES,
  fetchEmbeddingConfig,
  fetchKeyExtractorConfig,
  fetchVisionGateStatus,
  type VisionGateStatus,
  type ServiceConfig,
  type ConfigService,
  type EditableField,
  type DeviceEditableField,
  type DeviceOverrideSummaryItem,
  type OverrideMutationResult,
} from "./api";
import { PromptsPanel } from "./PromptsPanel";
import { DevicePicker } from "./DevicePicker";
import { deviceLabel, loadDeviceCandidates, type DeviceCandidate } from "./deviceCandidates";
import { useEditPassword } from "./editPassword";
import "./ConfigView.css";

/** 后端 started_at 已是 naive 北京时间字面量，原样展示即可 */
function formatStartedAt(s: string | null | undefined): string {
  if (!s) return "-";
  return s.replace("T", " ");
}

/** 状态条地址：统一展示 host:port */
function formatServiceAddr(data: ServiceConfig): string | null {
  if (data.host != null && data.host !== "" && data.port != null) {
    return `${data.host}:${data.port}`;
  }
  return null;
}

/* 顶层配置段的中文标题：帮助非开发同学快速定位；没收录的段直接显示原始字段名 */
/* 配置卡 tab 条（各服务切换展示, 与下方 ServiceCard 一一对应）。
   emb/keyext 是记忆 GPU 服务：配置来自 yaml(+机器本地 config_local.yaml)的冻结快照,
   进程启动即定死、不支持在线编辑（改端口/模型需重启, 临时覆盖走远端 config_local.yaml），
   故只读展示、不进 ConfigService 编辑体系 */
type ServiceTabKey = ConfigService | "emb" | "keyext";

const SERVICE_TABS: { key: ServiceTabKey; icon: string; label: string }[] = [
  { key: "voice", icon: "🎙️", label: "voice_server" },
  { key: "agent", icon: "🤖", label: "agent_server" },
  { key: "console", icon: "🖥️", label: "console_server" },
  { key: "memory", icon: "🧠", label: "family_memory" },
  { key: "person", icon: "👁️", label: "person_id" },
  { key: "emb", icon: "🧮", label: "embedding" },
  { key: "keyext", icon: "🗝️", label: "key-extractor" },
];

/* 保存/恢复提示条里「重启 xxx 后生效」用的服务进程名 */
const SERVER_NAMES: Record<ConfigService, string> = {
  voice: "voice_server",
  agent: "agent_server",
  console: "console_server",
  person: "person_id",
  memory: "family_memory",
};

const SECTION_LABELS: Record<string, string> = {
  audio: "音频参数",
  vad: "VAD 语音活动检测",
  asr: "ASR 语音识别",
  tts: "TTS 语音合成",
  wakeup_answers: "唤醒应答语",
  llm: "LLM 对话模型",
  emote_llm: "动作/表情决策 LLM",
  prompt: "提示词模板",
  memory: "记忆系统",
  bert_intent: "BERT 意图识别",
  llm_intent: "LLM 意图分类",
  web_search: "联网搜索",
  person_id: "身份识别",
  mqtt: "MQTT 消息通道",
  redis: "Redis",
  cos: "对象存储 COS",
  agent_server: "上游 agent_server",
  moderation: "输出侧内容风控",
  auto_stream: "摄像头自动拉流",
  voice_embed: "声纹提取",
  memory_server: "记忆服务摄取信号",
  // console_server (日志聚合) 的顶层配置段
  log_stream: "日志聚合 Stream",
  // family_memory (记忆服务) 的顶层配置段(memory 段复用上面的「记忆系统」)
  conversation_db_url: "会话库地址(只读事实源)",
  live_namespace: "环境命名空间",
  // person_id (视觉识别) 服务的顶层配置段
  hardware: "硬件与计算设备",
  detection: "检测 (YOLO)",
  face: "人脸识别",
  reid: "重识别 ReID",
  gallery: "特征底库",
  matching: "匹配与融合",
  tracking: "追踪引擎",
  multiframe: "多帧处理",
  vlm: "VLM 仲裁",
  server: "服务参数",
  // embedding-service / key-extractor (记忆 GPU 服务) 的顶层配置段
  serve: "服务参数（端口 / GPU / 模型）",
  deploy: "部署目标（rsync 推送机器）",
};

/** 把扁平 path 列表还原成与 yaml/全局配置卡同构的嵌套对象，供分级表格复用 */
function buildNestedConfig(fields: { path: string; value: unknown }[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const f of fields) {
    const parts = f.path.split(".");
    let cur: Record<string, unknown> = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      const next = cur[p];
      if (!isPlainObject(next)) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = f.value;
  }
  return root;
}

const LONG_TEXT_THRESHOLD = 120;

/* 枚举字段：值只能是固定几个实现名之一，编辑时渲染下拉选择而不是文本框
   （填错服务商名会导致下一轮识别/合成/对话报错，选择框从源头杜绝手滑）。
   llm.name 的候选须与 LLMConfig 的方案字段(doubao/gemini/qwen)保持一致，
   后端 validator 也会拦，但下拉让操作者根本不用记方案名 */

/* LLM 协议适配方案(provider)字段的候选值：与后端协议分支保持一致
   (voice_agent_common/utils/llm.py 的 shared_llm 与 voice_server/services/moderation/guard.py)。
   空串 = 方舟/标准 OpenAI 协议（下拉里展示为可读标签，见 EMPTY_OPTION_LABEL） */
const LLM_PROVIDERS = ["", "doubao", "gemini", "qwen"];

/* 下拉里空串选项的展示文案（值仍是 ""，只是显示得可读） */
const EMPTY_OPTION_LABEL = "（空 = 方舟/标准 OpenAI 协议）";

const ENUM_OPTIONS: Record<string, string[]> = {
  "asr.name": ["xiaodu", "azure", "volcengine"],
  "asr.volcengine.mode": ["bigmodel", "bigmodel_async", "bigmodel_nostream"],
  "tts.name": ["minimax", "azure"],
  "llm.name": ["doubao", "gemini", "qwen"],
  // 各处 LLM endpoint 的协议适配方案：agent 三处 + voice 风控一处
  "emote_llm.provider": LLM_PROVIDERS,
  "llm_intent.llm.provider": LLM_PROVIDERS,
  "memory.llm.provider": LLM_PROVIDERS,
  "moderation.llm.provider": LLM_PROVIDERS,
  // 摄像头自动拉流：与 AutoStreamConfig 的 Literal 取值保持一致
  "auto_stream.mode": ["connection", "wake"],
  // person_id (视觉识别) 的模型选择字段
  "face.recognition_backend": ["arcface", "adaface"],
  "gallery.ediffiqa_enroll_variant": ["tiny", "small", "medium", "large"],
  // person_id 声纹提取的 ONNX 执行设备（硬件 provider，与 LLM provider 无关）
  "voice_embed.provider": ["cuda", "cpu"],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* ── 在线编辑（DB 覆盖层）──
   编辑后的值存数据库并立即生效（非 hot 项重启后生效）；「恢复默认」删除
   数据库覆盖、回到 yaml 原值。全部叶子配置可编辑（后端锁定项除外），
   保存/恢复前需输入编辑口令（弹窗/缓存逻辑在共享的 useEditPassword，
   与 vision 页 Controls 滑块共用同一口令缓存）。 */

export type SaveOverrideFn = (path: string, value: unknown) => Promise<OverrideMutationResult>;
export type RevertOverrideFn = (path: string) => Promise<OverrideMutationResult>;

interface EditCtx {
  fields: Map<string, EditableField>;
  onSave: SaveOverrideFn;
  onRevert: RevertOverrideFn;
  /** 设备级/分组级面板传入：行徽标切到「本作用域覆盖 / 跟随全局修改」三层值来源 */
  deviceFields?: Map<string, DeviceEditableField>;
  /** deviceFields 的作用域（徽标与提示文案随之切换），缺省 device */
  scope?: ScopeKind;
}

/* 定向覆盖的两种作用域：设备(device_sn) / 分组(握手头 Biz)。文案按作用域切换 */
type ScopeKind = "device" | "group";

const SCOPE_TEXT: Record<ScopeKind, { badge: string; self: string; target: string }> = {
  device: { badge: "设备覆盖", self: "本设备", target: "该设备" },
  group: { badge: "分组覆盖", self: "本分组的设备", target: "该分组的设备" },
};

/** 编辑框里的文本 ←→ 配置值 的互转，按原值(baseline)的类型决定形态 */
function valueToDraft(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join("\n");
  return String(v ?? "");
}

function draftToValue(draft: string, sample: unknown): unknown {
  if (Array.isArray(sample)) {
    return draft.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  if (typeof sample === "number") {
    const n = Number(draft.trim());
    if (draft.trim() === "" || Number.isNaN(n)) throw new Error("请输入数字");
    return n;
  }
  if (typeof sample === "boolean") return draft === "true";
  return draft;
}

/* 写覆盖成功后到重拉之间的沉降等待。后端多实例部署时, 改动经 Redis Pub/Sub
   通知其他实例 reload(毫秒级), 而 LB 轮询几乎必然把紧随 PUT 的重拉 GET 打到
   另一台实例——不等一下就会拿到它尚未 reload 的旧值, 表现为"保存后要手动
   刷新才看到新值"。600ms 比同步窗口(几十毫秒)大一个数量级, 又淹没在行内
   编辑器本来就有的"保存中"状态里, 用户无感。 */
const SYNC_SETTLE_MS = 600;
const syncSettle = () => new Promise<void>((r) => setTimeout(r, SYNC_SETTLE_MS));

/** 值的短预览（「已修改」徽标的 data-tip 展示原值用） */
function previewValue(v: unknown): string {
  const s = Array.isArray(v) ? v.map(String).join(" | ") : String(v ?? "-");
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

/** 行内编辑器：标量用 input / 布尔用下拉 / 列表与长文本用 textarea /
    含对象的列表用 JSON / 敏感字段不回显、从空白开始输入 */
function FieldEditor({
  field,
  onSave,
  onCancel,
}: {
  field: EditableField;
  onSave: (value: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const sample = field.baseline;
  const enumOptions = ENUM_OPTIONS[field.path];
  const jsonMode = Array.isArray(sample) && sample.some((v) => isPlainObject(v));
  const [draft, setDraft] = useState(() => {
    if (field.sensitive) return "";  // 脱敏字段不回显当前值
    if (jsonMode) return JSON.stringify(field.value, null, 2);
    return valueToDraft(field.value);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const multiline =
    jsonMode ||
    Array.isArray(sample) ||
    (typeof sample === "string" && (sample.length > LONG_TEXT_THRESHOLD || sample.includes("\n")));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      let value: unknown;
      if (jsonMode) {
        try {
          value = JSON.parse(draft);
        } catch {
          throw new Error("JSON 解析失败，请检查格式");
        }
      } else if (field.sensitive) {
        value = draft;  // 脱敏字段按字符串原样提交
      } else {
        value = draftToValue(draft, sample);
      }
      await onSave(value);
    } catch (e: any) {
      setError(e.message || String(e));
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div className="cfg-edit-box">
      {enumOptions ? (
        <select value={draft} onChange={(e) => setDraft(e.target.value)} disabled={saving}>
          {/* 当前值不在选项里时（如后端已在线改成未知值）也列出来，避免下拉悄悄换值 */}
          {!enumOptions.includes(draft) && <option value={draft}>{draft}</option>}
          {enumOptions.map((o) => (
            <option value={o} key={o}>{o === "" ? EMPTY_OPTION_LABEL : o}</option>
          ))}
        </select>
      ) : typeof sample === "boolean" ? (
        <select value={draft} onChange={(e) => setDraft(e.target.value)} disabled={saving}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : multiline ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Array.isArray(sample) ? Math.max(3, (sample as unknown[]).length + 1) : 10}
          placeholder={jsonMode ? "JSON 格式" : Array.isArray(sample) ? "一行一条" : ""}
          disabled={saving}
        />
      ) : (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={field.sensitive ? "当前值已脱敏不回显，输入新值将整体替换" : ""}
          disabled={saving}
        />
      )}
      {jsonMode
        ? <div className="cfg-edit-hint">JSON 格式编辑（列表里含对象）</div>
        : Array.isArray(sample) && <div className="cfg-edit-hint">列表项一行一条，空行忽略</div>}
      {error && <div className="cfg-error">❌ {error}</div>}
      <div className="cfg-edit-actions">
        <button className="cfg-edit-save" onClick={save} disabled={saving}>
          {saving ? <span className="spinner inline" /> : "保存"}
        </button>
        <button className="cfg-edit-cancel" onClick={onCancel} disabled={saving}>取消</button>
      </div>
    </div>
  );
}

/** 可编辑行的右侧附加区：编辑按钮 + 来源徽标 + 恢复。
   全局视图：已修改 / 重启生效 / N 台设备覆盖；
   设备视图（有 deviceField）：设备覆盖 / 跟随全局修改 */
function EditControls({
  field,
  deviceField,
  scope = "device",
  onEdit,
  onRevert,
}: {
  field: EditableField;
  deviceField?: DeviceEditableField;
  scope?: ScopeKind;
  onEdit: () => void;
  onRevert: () => Promise<void>;
}) {
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = SCOPE_TEXT[scope];

  const revert = async () => {
    if (reverting) return;
    setReverting(true);
    setError(null);
    try {
      await onRevert();
    } catch (e: any) {
      setError(e.message || String(e));
    }
    setReverting(false);
  };

  const globalModified = deviceField
    && !deviceField.sensitive
    && !sameValue(deviceField.global_value, deviceField.baseline);

  return (
    <span className="cfg-edit-controls">
      {deviceField ? (
        <>
          {deviceField.overridden ? (
            <span
              className="cfg-badge device-override"
              data-tip={`此值仅对${t.self}生效。全局生效值: ${deviceField.sensitive ? "***" : previewValue(deviceField.global_value)}`}
            >
              {t.badge}
            </span>
          ) : globalModified ? (
            <span
              className="cfg-badge modified"
              data-tip={`${t.self}无定向覆盖，跟随全局在线修改的值。yaml 原值: ${previewValue(deviceField.baseline)}`}
            >
              跟随全局修改
            </span>
          ) : null}
        </>
      ) : (
        <>
          {field.overridden && (
            <span className="cfg-badge modified" data-tip={`已被在线编辑覆盖，yaml 原值: ${previewValue(field.baseline)}`}>
              已修改
            </span>
          )}
          {field.overridden && !field.hot && (
            <span className="cfg-badge restart" data-tip="该覆盖值需重启对应服务才生效">重启生效</span>
          )}
          {field.device_override_count > 0 && (
            <span
              className="cfg-badge device"
              data-tip={`另有 ${field.device_override_count} 台设备对此项做了定向覆盖（那些设备不跟随此处的全局值），详见「设备级配置覆盖」面板`}
            >
              {field.device_override_count} 台设备覆盖
            </span>
          )}
          {(field.group_override_count ?? 0) > 0 && (
            <span
              className="cfg-badge device"
              data-tip={`另有 ${field.group_override_count} 个配置分组对此项做了覆盖（分组内的设备不跟随此处的全局值），详见「配置分组」面板`}
            >
              {field.group_override_count} 个分组覆盖
            </span>
          )}
        </>
      )}
      <button
        className="cfg-edit-btn"
        data-tip={
          deviceField
            ? ((deviceField.description || `为${t.target}设置定向覆盖值`) +
              `；只对${t.target}生效，改完下一轮请求即用新值`)
            : ((field.description || "在线编辑此配置项（存数据库，可随时恢复默认）") +
              (field.hot ? "" : "；保存后需重启对应服务生效"))
        }
        onClick={onEdit}
      >✏️</button>
      {(deviceField ? deviceField.overridden : field.overridden) && (
        <button
          className="cfg-edit-btn revert"
          data-tip={deviceField ? `删除${t.target}的定向覆盖，回落到全局生效值` : "删除数据库里的覆盖值，恢复 yaml 原值"}
          onClick={revert}
          disabled={reverting}
        >
          {reverting ? <span className="spinner inline" /> : "↺"}
        </button>
      )}
      {error && <span className="cfg-error inline">❌ {error}</span>}
    </span>
  );
}

/** 一行配置（键 + 值 + 可编辑附加区）。命中后端白名单的行才有编辑入口 */
function ConfigRow({
  name,
  value,
  path,
  edit,
}: {
  name: string;
  value: unknown;
  path: string;
  edit?: EditCtx;
}) {
  const field = edit?.fields.get(path);
  const deviceField = edit?.deviceFields?.get(path);
  const [editing, setEditing] = useState(false);

  return (
    <div className={`cfg-row ${field ? "editable" : ""}`}>
      <span className="cfg-key">{name}</span>
      {editing && field && edit ? (
        <FieldEditor
          field={field}
          onSave={async (v) => {
            await edit.onSave(path, v);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <ConfigValue value={value} path={path} edit={edit} />
          {field && edit && (
            <EditControls
              field={field}
              deviceField={deviceField}
              scope={edit.scope}
              onEdit={() => setEditing(true)}
              onRevert={() => edit.onRevert(path).then(() => undefined)}
            />
          )}
        </>
      )}
    </div>
  );
}

/** 单个配置值的渲染：脱敏值、布尔、长文本、数组、嵌套对象各有形态 */
function ConfigValue({ value, path = "", edit }: { value: unknown; path?: string; edit?: EditCtx }) {
  if (value === null || value === undefined) {
    return <span className="cfg-null">-</span>;
  }
  if (value === "***") {
    return <span className="cfg-masked" data-tip="敏感字段，后端已脱敏">🔒 已脱敏</span>;
  }
  if (typeof value === "boolean") {
    return <span className={`cfg-bool ${value ? "on" : "off"}`}>{value ? "✔ true" : "✘ false"}</span>;
  }
  if (typeof value === "number") {
    return <span className="cfg-number">{String(value)}</span>;
  }
  if (typeof value === "string") {
    if (value.length > LONG_TEXT_THRESHOLD || value.includes("\n")) {
      return (
        <details className="cfg-longtext">
          <summary>长文本（{value.length} 字符），点击展开</summary>
          <pre>{value}</pre>
        </details>
      );
    }
    return <span className="cfg-string">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="cfg-null">[]</span>;
    if (value.every((v) => !isPlainObject(v) && !Array.isArray(v))) {
      return (
        <span className="cfg-array">
          {value.map((v, i) => (
            <span className="cfg-array-item" key={i}>{String(v)}</span>
          ))}
        </span>
      );
    }
    return (
      <div className="cfg-nested">
        {value.map((v, i) => (
          <div className="cfg-row" key={i}>
            <span className="cfg-key">[{i}]</span>
            <ConfigValue value={v} />
          </div>
        ))}
      </div>
    );
  }
  if (isPlainObject(value)) {
    return (
      <div className="cfg-nested">
        {Object.entries(value).map(([k, v]) => (
          <ConfigRow name={k} value={v} path={path ? `${path}.${k}` : k} edit={edit} key={k} />
        ))}
      </div>
    );
  }
  return <span className="cfg-string">{String(value)}</span>;
}

/* 「基础参数」tab 的内部 key：顶层标量的归集段，不是真实配置段名，
   用带下划线的哨兵值避免与某个真实顶层段撞名 */
const BASIC_TAB_KEY = "__basic__";

/** 配置分级表格：顶层标量归入「基础参数」，每个顶层对象/数组单独成段，
    以 tab 形式切换展示（全局卡与设备级面板共用）。
    tab 上的黄色角标 = 该分类下被在线修改（设备视图为被此设备覆盖）的条数，
    避免内容折进 tab 后覆盖项被藏住看不见 */
function ConfigSections({
  config,
  hideSections,
  edit,
}: {
  config: Record<string, unknown>;
  hideSections?: string[];
  edit?: EditCtx;
}) {
  const scalarEntries = Object.entries(config).filter(([, v]) => !isPlainObject(v) && !Array.isArray(v));
  const sectionEntries = Object.entries(config).filter(
    ([k, v]) => (isPlainObject(v) || Array.isArray(v)) && !hideSections?.includes(k));
  const scalarKeys = new Set(scalarEntries.map(([k]) => k));

  const tabs: { key: string; label: string }[] = [
    ...(scalarEntries.length > 0 ? [{ key: BASIC_TAB_KEY, label: "基础参数" }] : []),
    ...sectionEntries.map(([k]) => ({ key: k, label: SECTION_LABELS[k] || k })),
  ];

  const [active, setActive] = useState(tabs[0]?.key ?? "");
  /* 刷新后段列表可能变化（如服务重启后配置结构变了）：选中项失效时回落到第一个 tab */
  const activeKey = tabs.some((t) => t.key === active) ? active : tabs[0]?.key;

  /* 该分类下被覆盖条数（设备视图 fields 的 overridden 即「被此设备覆盖」，语义同样成立）。
     「基础参数」按 scalarKeys 判定而不是「path 不含点」：顶层数组（如 wakeup_answer_devices）
     的 path 也不含点，但它渲染在自己的段 tab 里，不能算进基础参数 */
  const overriddenCount = (tabKey: string): number => {
    if (!edit) return 0;
    let n = 0;
    for (const f of edit.fields.values()) {
      if (!f.overridden) continue;
      const inTab = tabKey === BASIC_TAB_KEY
        ? scalarKeys.has(f.path)
        : f.path === tabKey || f.path.startsWith(tabKey + ".");
      if (inTab) n++;
    }
    return n;
  };

  if (tabs.length === 0) return null;

  return (
    <>
      <div className="cfg-section-tabs">
        {tabs.map((t) => {
          const n = overriddenCount(t.key);
          return (
            <button
              key={t.key}
              className={`cfg-section-tab ${activeKey === t.key ? "active" : ""}`}
              onClick={() => setActive(t.key)}
            >
              {t.label}
              {n > 0 && (
                <span className="cfg-section-tab-count" data-tip="该分类下被在线修改的条数">{n}</span>
              )}
            </button>
          );
        })}
      </div>

      {activeKey === BASIC_TAB_KEY && (
        <div className="cfg-section">
          <h4 className="cfg-section-title">基础参数</h4>
          <div className="cfg-rows">
            {scalarEntries.map(([k, v]) => (
              <ConfigRow name={k} value={v} path={k} edit={edit} key={k} />
            ))}
          </div>
        </div>
      )}

      {sectionEntries.filter(([k]) => k === activeKey).map(([k, v]) => (
        <div className="cfg-section" key={k}>
          <h4 className="cfg-section-title">
            {SECTION_LABELS[k] || k}
            {SECTION_LABELS[k] && <code className="cfg-section-key">{k}</code>}
          </h4>
          <div className="cfg-rows">
            {Array.isArray(v) ? (
              <ConfigRow name={k} value={v} path={k} edit={edit} />
            ) : (
              <ConfigValue value={v} path={k} edit={edit} />
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/** 一个服务的配置卡片：顶层标量归入「基础参数」，每个顶层对象/数组单独成段 */
function ServiceCard({
  icon,
  title,
  subtitle,
  data,
  error,
  loading,
  hideSections,
  edit,
}: {
  icon: string;
  title: string;
  subtitle: string;
  data: ServiceConfig | null;
  error: string | null;
  loading: boolean;
  /** 不在分段区展示的顶层段（已有专门面板承接的，如 prompt；原始 JSON 里仍保留） */
  hideSections?: string[];
  /** 在线编辑上下文；后端白名单接口不可用时为 undefined，卡片退化为纯只读 */
  edit?: EditCtx;
}) {
  return (
    <div className="card cfg-card">
      {/* 版本/环境/启动时间/依赖包版本统一在顶部状态条展示，此处不重复 */}
      <h3>
        {icon} {title}
        <span className="subtitle">{subtitle}</span>
      </h3>

      {error && <div className="cfg-error">❌ 加载失败: {error}</div>}
      {loading && !data && !error && (
        <div className="empty"><div className="spinner" /></div>
      )}

      {data && (
        <>
          <ConfigSections config={data.config} hideSections={hideSections} edit={edit} />

          <details className="cfg-raw">
            <summary>原始 JSON（已脱敏）</summary>
            <pre>{JSON.stringify(data.config, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ── 设备级配置覆盖面板 ──
   只对选中 device_sn 生效的定向配置修改（优先级最高：设备覆盖 > 全局覆盖 > yaml），
   可编辑范围 = hot（热生效）字段。顶部总览列出所有有覆盖的设备（防遗忘入口）。
   字段展示复用全局配置卡的 ConfigSections 分级表格（扁平 path 还原成嵌套树）。 */

type WithPasswordFn = <T>(call: (pw: string) => Promise<T>) => Promise<T>;

const SERVICE_META: { key: ConfigService; icon: string; title: string }[] = [
  { key: "voice", icon: "🎙️", title: "voice_server" },
  { key: "agent", icon: "🤖", title: "agent_server" },
];

function DeviceOverridePanel({
  withPassword,
  setNotice,
  onGlobalReload,
  refreshSignal,
}: {
  withPassword: WithPasswordFn;
  setNotice: (msg: string) => void;
  /** 保存/删除设备覆盖后刷新全局视图（「N 台设备覆盖」计数会变） */
  onGlobalReload: () => Promise<void>;
  /** 页面上其他入口（提示词面板）改了设备覆盖后递增，本面板静默重载总览与当前设备 */
  refreshSignal: number;
}) {
  /* 有覆盖的设备总览（两服务合并计数） */
  const [summary, setSummary] = useState<Map<string, DeviceOverrideSummaryItem>>(new Map());
  /* 选择器候选：最近有会话的设备 + 总览里出现的设备 */
  const [candidates, setCandidates] = useState<DeviceCandidate[]>([]);
  const [selected, setSelected] = useState("");
  const [fields, setFields] = useState<Partial<Record<ConfigService, DeviceEditableField[]>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* 两个服务(voice/agent)的设备级配置用 tab 切换展示, 与上方全局配置卡一致 */
  const [svcTab, setSvcTab] = useState<ConfigService>("voice");

  const loadOverview = useCallback(async () => {
    const next = await loadDeviceCandidates(["voice", "agent"]);
    setSummary(next.summary);
    setCandidates(next.candidates);
  }, []);

  const loadDevice = useCallback(async (sn: string, opts?: { silent?: boolean }) => {
    if (!sn) {
      setFields(null);
      return;
    }
    /* 保存/恢复后的静默刷新不要闪 loading：否则整表卸掉再挂上，视口会跟着跳一段 */
    if (!opts?.silent) setLoading(true);
    setError(null);
    const [v, a] = await Promise.allSettled([
      fetchDeviceEditableConfig("voice", sn),
      fetchDeviceEditableConfig("agent", sn),
    ]);
    const next: Partial<Record<ConfigService, DeviceEditableField[]>> = {};
    if (v.status === "fulfilled") next.voice = v.value.items;
    if (a.status === "fulfilled") next.agent = a.value.items;
    if (v.status === "rejected" && a.status === "rejected") {
      setError(v.reason?.message || String(v.reason));
      setFields(null);
    } else {
      setFields(next);
    }
    if (!opts?.silent) setLoading(false);
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadDevice(selected);
  }, [selected, loadDevice]);

  /* 外部改了设备覆盖：只在信号真的变化时静默重载，不跟着 selected 变化重复触发 */
  const seenSignal = useRef(refreshSignal);
  useEffect(() => {
    if (seenSignal.current === refreshSignal) return;
    seenSignal.current = refreshSignal;
    loadOverview();
    loadDevice(selected, { silent: true });
  }, [refreshSignal, loadOverview, loadDevice, selected]);

  const afterMutation = useCallback(async () => {
    await syncSettle();
    await Promise.all([loadDevice(selected, { silent: true }), loadOverview(), onGlobalReload()]);
  }, [loadDevice, loadOverview, onGlobalReload, selected]);

  return (
    <div className="card cfg-card">
      <h3>
        📟 设备级配置覆盖
        <span className="subtitle">只对选中设备生效的定向修改（优先级最高），其他设备不受影响；仅热生效字段支持</span>
      </h3>

      <div className="cfg-device-toolbar">
        <label>
          选择设备：
          <DevicePicker
            value={selected}
            onChange={setSelected}
            candidates={candidates}
            badgeFor={(sn) => {
              const n = summary.get(sn)?.override_count ?? 0;
              return n > 0 ? `${n} 条覆盖` : null;
            }}
          />
        </label>
        {summary.size > 0 && (
          <span className="cfg-device-summary">
            当前有定向覆盖的设备：
            {[...summary.values()].map((d) => (
              <button
                className={`cfg-device-chip ${d.device_sn === selected ? "active" : ""}`}
                data-tip="点击查看/编辑该设备的定向覆盖"
                onClick={() => setSelected(d.device_sn)}
                key={d.device_sn}
              >
                {deviceLabel(d.device_sn, d.name)} · {d.override_count} 条
              </button>
            ))}
          </span>
        )}
        {summary.size === 0 && (
          <span className="cfg-device-summary muted">当前没有任何设备被定向覆盖</span>
        )}
      </div>

      {error && <div className="cfg-error">❌ 加载失败: {error}</div>}
      {loading && <div className="empty"><div className="spinner" /></div>}

      {selected && fields && !loading && (
        <div className="cfg-device-sections">
          <div className="cfg-service-tabs cfg-device-tabs">
            {SERVICE_META.map(({ key, icon, title }) => {
              const overridden = fields[key]?.filter((f) => f.overridden).length ?? 0;
              return (
                <button
                  key={key}
                  className={`cfg-service-tab ${svcTab === key ? "active" : ""}`}
                  onClick={() => setSvcTab(key)}
                >
                  <span className="cfg-service-tab-icon">{icon}</span>
                  {title}
                  {overridden > 0 && (
                    <span className="cfg-service-tab-count">{overridden}</span>
                  )}
                </button>
              );
            })}
          </div>
          {SERVICE_META.filter(({ key }) => key === svcTab).map(({ key, icon, title }) => {
            const items = fields[key];
            if (!items) {
              return (
                <div className="cfg-section" key={key}>
                  <h4 className="cfg-section-title">{icon} {title}</h4>
                  <div className="cfg-error">❌ 该服务的设备配置接口不可用</div>
                </div>
              );
            }
            /* 扁平可编辑项还原成嵌套树，复用全局配置卡的分级表格 */
            const nested = buildNestedConfig(items);
            const deviceFields = new Map(items.map((f) => [f.path, f]));
            const editFields = new Map<string, EditableField>(
              items.map((f) => [f.path, { ...f, hot: true, device_override_count: 0, group_override_count: 0 }]),
            );
            const edit: EditCtx = {
              fields: editFields,
              deviceFields,
              onSave: async (path, value) => {
                const result = await withPassword((pw) =>
                  putDeviceConfigOverride(key, selected, path, value, pw));
                setNotice(`✅ ${path} 已保存为设备 ${selected} 的定向覆盖，仅该设备生效`);
                await afterMutation();
                return result;
              },
              onRevert: async (path) => {
                const result = await withPassword((pw) =>
                  deleteDeviceConfigOverride(key, selected, path, pw));
                setNotice(`↩️ ${path} 已删除设备 ${selected} 的定向覆盖，回落到全局生效值`);
                await afterMutation();
                return result;
              },
            };
            return (
              <div className="cfg-section" key={key}>
                <h4 className="cfg-section-title">
                  {icon} {title}
                  <span className="cfg-section-key">
                    {items.filter((f) => f.overridden).length} / {items.length} 项被此设备覆盖
                  </span>
                </h4>
                <ConfigSections config={nested} edit={edit} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── 配置分组面板 ──
   按设备握手头 Biz 归类：先建分组（分组名 = Biz 取值，如 KAIDISHI），再给分组挂覆盖，
   Biz 与分组名逐字相同的设备用分组的值。优先级：设备覆盖 > 分组覆盖 > 全局覆盖 > yaml。
   分组档案 voice/agent 共用；建分组任选一个服务调，删分组对每个服务各调一次。 */

/** 两服务的分组列表合并：档案同源，覆盖条数按服务分别记 */
interface GroupRow {
  name: string;
  description: string;
  created_at: string;
  counts: Partial<Record<ConfigService, number>>;
}

async function loadGroupRows(): Promise<{ rows: GroupRow[]; error: string | null }> {
  const results = await Promise.allSettled(GROUP_SERVICES.map((s) => fetchConfigGroups(s)));
  const merged = new Map<string, GroupRow>();
  let firstError: string | null = null;
  results.forEach((r, i) => {
    const service = GROUP_SERVICES[i];
    if (r.status !== "fulfilled") {
      firstError ??= errorText(r.reason);
      return;
    }
    for (const g of r.value.groups) {
      const row = merged.get(g.name) ?? { name: g.name, description: g.description, created_at: g.created_at, counts: {} };
      row.counts[service] = g.override_count;
      merged.set(g.name, row);
    }
  });
  const allFailed = results.every((r) => r.status === "rejected");
  return {
    rows: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
    error: allFailed ? firstError : null,
  };
}

function groupTotal(row: GroupRow): number {
  return Object.values(row.counts).reduce((a, b) => a + (b ?? 0), 0);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ConfigGroupPanel({
  withPassword,
  setNotice,
  onGlobalReload,
  refreshSignal,
}: {
  withPassword: WithPasswordFn;
  setNotice: (msg: string) => void;
  /** 保存/删除分组覆盖后刷新全局视图（「N 个分组覆盖」计数会变） */
  onGlobalReload: () => Promise<void>;
  /** 页面上其他入口（提示词面板）改了分组覆盖后递增，本面板静默重载列表与当前分组 */
  refreshSignal: number;
}) {
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [selected, setSelected] = useState("");
  const [fields, setFields] = useState<Partial<Record<ConfigService, DeviceEditableField[]>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [svcTab, setSvcTab] = useState<ConfigService>("voice");
  /* 新建分组表单 */
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadRows = useCallback(async () => {
    const next = await loadGroupRows();
    setRows(next.rows);
    if (next.error) setError(next.error);
  }, []);

  const loadGroup = useCallback(async (name: string, opts?: { silent?: boolean }) => {
    if (!name) {
      setFields(null);
      return;
    }
    if (!opts?.silent) setLoading(true);
    setError(null);
    const results = await Promise.allSettled(GROUP_SERVICES.map((s) => fetchGroupEditableConfig(s, name)));
    const next: Partial<Record<ConfigService, DeviceEditableField[]>> = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") next[GROUP_SERVICES[i]] = r.value.items;
    });
    if (results.every((r) => r.status === "rejected")) {
      setError(errorText((results[0] as PromiseRejectedResult).reason));
      setFields(null);
    } else {
      setFields(next);
    }
    if (!opts?.silent) setLoading(false);
  }, []);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  useEffect(() => {
    loadGroup(selected);
  }, [selected, loadGroup]);

  /* 外部改了分组覆盖：只在信号真的变化时静默重载，不跟着 selected 变化重复触发 */
  const seenSignal = useRef(refreshSignal);
  useEffect(() => {
    if (seenSignal.current === refreshSignal) return;
    seenSignal.current = refreshSignal;
    loadRows();
    loadGroup(selected, { silent: true });
  }, [refreshSignal, loadRows, loadGroup, selected]);

  const afterMutation = useCallback(async () => {
    await syncSettle();
    await Promise.all([loadGroup(selected, { silent: true }), loadRows(), onGlobalReload()]);
  }, [loadGroup, loadRows, onGlobalReload, selected]);

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setCreateError("请输入分组名");
      return;
    }
    setBusy(true);
    setCreateError(null);
    try {
      /* 档案两服务共用：任选一个服务写入即可；首选不可用时换下一个 */
      let lastErr: unknown = null;
      let created = false;
      for (const s of GROUP_SERVICES) {
        try {
          await withPassword((pw) => createConfigGroup(s, name, newDesc.trim(), pw));
          created = true;
          break;
        } catch (e) {
          lastErr = e;
          /* 业务拒绝（重名/名字不合规/口令错）换服务也不会变，直接报出 */
          if (/已存在|分组名|口令/.test(errorText(e))) break;
        }
      }
      if (!created) throw lastErr;
      setNotice(`✅ 已创建配置分组 ${name}，握手头 Biz=${name} 的设备将使用该分组的覆盖`);
      setCreating(false);
      setNewName("");
      setNewDesc("");
      await loadRows();
      setSelected(name);
    } catch (e) {
      setCreateError(errorText(e));
    }
    setBusy(false);
  };

  const removeGroup = async (row: GroupRow) => {
    const total = groupTotal(row);
    const ok = window.confirm(
      total > 0
        ? `删除分组 ${row.name} 会同时删掉它的 ${total} 条覆盖，该分组的设备将回落到全局配置。确定？`
        : `确定删除分组 ${row.name}？`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      /* 每个服务各删一次：各自清覆盖并广播到自己的实例；一个失败不影响另一个已完成的 */
      const results = await withPassword((pw) =>
        Promise.allSettled(GROUP_SERVICES.map((s) => deleteConfigGroup(s, row.name, pw))));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
      setNotice(`🗑️ 已删除配置分组 ${row.name}`);
      if (selected === row.name) setSelected("");
      await afterMutation();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const selectedRow = rows.find((r) => r.name === selected);

  return (
    <div className="card cfg-card">
      <h3>
        🏷️ 配置分组
        <span className="subtitle">
          按设备握手头 Biz 归类：Biz 与分组名相同的设备用该分组的覆盖；优先级 设备覆盖 &gt; 分组覆盖 &gt; 全局；仅热生效字段支持
        </span>
      </h3>

      <div className="cfg-device-toolbar">
        {rows.length > 0 ? (
          <span className="cfg-device-summary">
            分组：
            {rows.map((r) => {
              const n = groupTotal(r);
              return (
                <button
                  className={`cfg-device-chip ${r.name === selected ? "active" : ""}`}
                  data-tip={(r.description ? `${r.description}；` : "") + "点击查看/编辑该分组的覆盖"}
                  onClick={() => setSelected(r.name === selected ? "" : r.name)}
                  key={r.name}
                >
                  {r.name}{n > 0 ? ` · ${n} 条` : ""}
                </button>
              );
            })}
          </span>
        ) : (
          <span className="cfg-device-summary muted">还没有配置分组</span>
        )}
        {!creating && (
          <button className="cfg-edit-cancel" onClick={() => setCreating(true)} disabled={busy}>
            ＋ 新建分组
          </button>
        )}
      </div>

      {creating && (
        <div className="cfg-group-create">
          <input
            placeholder="分组名 = 设备握手头 Biz 的取值，如 KAIDISHI（字母/数字/_ . -，区分大小写）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitCreate(); }}
            autoFocus
            disabled={busy}
          />
          <input
            placeholder="说明（可选）"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitCreate(); }}
            disabled={busy}
          />
          <div className="cfg-edit-actions">
            <button className="cfg-edit-save" onClick={submitCreate} disabled={busy}>
              {busy ? <span className="spinner inline" /> : "创建"}
            </button>
            <button
              className="cfg-edit-cancel"
              onClick={() => { setCreating(false); setCreateError(null); }}
              disabled={busy}
            >
              取消
            </button>
            {createError && <span className="cfg-error inline">❌ {createError}</span>}
          </div>
        </div>
      )}

      {error && <div className="cfg-error">❌ {error}</div>}
      {loading && <div className="empty"><div className="spinner" /></div>}

      {selected && selectedRow && fields && !loading && (
        <div className="cfg-device-sections">
          <div className="cfg-group-head">
            <span className="cfg-group-name">{selectedRow.name}</span>
            {selectedRow.description && <span className="cfg-group-desc">{selectedRow.description}</span>}
            <span className="cfg-group-meta">创建于 {formatStartedAt(selectedRow.created_at)}</span>
            <button
              className="cfg-edit-btn revert cfg-group-delete"
              data-tip="删除该分组及其全部覆盖，分组内设备回落到全局配置"
              onClick={() => removeGroup(selectedRow)}
              disabled={busy}
            >
              🗑️ 删除分组
            </button>
          </div>
          <div className="cfg-service-tabs cfg-device-tabs">
            {SERVICE_META.map(({ key, icon, title }) => {
              const overridden = fields[key]?.filter((f) => f.overridden).length ?? 0;
              return (
                <button
                  key={key}
                  className={`cfg-service-tab ${svcTab === key ? "active" : ""}`}
                  onClick={() => setSvcTab(key)}
                >
                  <span className="cfg-service-tab-icon">{icon}</span>
                  {title}
                  {overridden > 0 && (
                    <span className="cfg-service-tab-count">{overridden}</span>
                  )}
                </button>
              );
            })}
          </div>
          {SERVICE_META.filter(({ key }) => key === svcTab).map(({ key, icon, title }) => {
            const items = fields[key];
            if (!items) {
              return (
                <div className="cfg-section" key={key}>
                  <h4 className="cfg-section-title">{icon} {title}</h4>
                  <div className="cfg-error">❌ 该服务的分组配置接口不可用</div>
                </div>
              );
            }
            const nested = buildNestedConfig(items);
            const groupFields = new Map(items.map((f) => [f.path, f]));
            const editFields = new Map<string, EditableField>(
              items.map((f) => [f.path, { ...f, hot: true, device_override_count: 0, group_override_count: 0 }]),
            );
            const edit: EditCtx = {
              fields: editFields,
              deviceFields: groupFields,
              scope: "group",
              onSave: async (path, value) => {
                const result = await withPassword((pw) =>
                  putGroupConfigOverride(key, selected, path, value, pw));
                setNotice(`✅ ${path} 已保存为分组 ${selected} 的覆盖，Biz=${selected} 的设备下一轮即生效`);
                await afterMutation();
                return result;
              },
              onRevert: async (path) => {
                const result = await withPassword((pw) =>
                  deleteGroupConfigOverride(key, selected, path, pw));
                setNotice(`↩️ ${path} 已删除分组 ${selected} 的覆盖，回落到全局生效值`);
                await afterMutation();
                return result;
              },
            };
            return (
              <div className="cfg-section" key={key}>
                <h4 className="cfg-section-title">
                  {icon} {title}
                  <span className="cfg-section-key">
                    {items.filter((f) => f.overridden).length} / {items.length} 项被此分组覆盖
                  </span>
                </h4>
                <ConfigSections config={nested} edit={edit} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** base_url → host:port，与其它服务的地址展示口径一致 */
function hostPortOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** 模型徽标的悬浮提示：门控参数一行 + /health 响应原文整体铺开（tooltip 是 pre-line，
    靠换行分行）：一行一个字段，嵌套对象展开成缩进子行，数组/标量直接转文本，
    服务新增字段也照样显示；模型没带 model_info.json 时提示一句怎么补 */
function describeGate(s: VisionGateStatus): string {
  const lines: string[] = [
    `门控：${s.enabled ? "已开启" : "已关闭"} · 阈值 ${s.threshold}（P(vision) ≥ 阈值才带图）${s.use_context ? " · 带上文（拼上一轮对话做双句输入）" : ""}`,
    `GET ${s.base_url.replace(/\/+$/, "")}/health${s.latency_ms != null ? `（往返 ${s.latency_ms}ms）` : ""}`,
  ];
  const h = s.health;
  if (!h) return [...lines, "（无响应）"].join("\n");
  const fmt = (v: unknown): string => {
    if (v == null) return "-";
    if (Array.isArray(v)) return v.map(fmt).join(", ");
    if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}=${fmt(x)}`).join(", ");
    return String(v);
  };
  for (const [k, v] of Object.entries(h)) {
    if (v != null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 2) {
      lines.push(`${k}:`);
      // 全角空格缩进：tooltip 是 pre-line，普通空格会被折叠
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) lines.push(`\u3000· ${ck}: ${fmt(cv)}`);
    } else {
      lines.push(`${k}: ${fmt(v)}`);
    }
  }
  if (!s.model_info || !Object.keys(s.model_info).length) {
    lines.push("（服务未带 model_info.json，版本退化为 model.onnx 修改时间；重新 convert 导出即有）");
  }
  return lines.join("\n");
}

/** 视觉门控 BERT 服务的状态项：走 agent_server 探活(含在线覆盖的 base_url)，
    地址显示 agent 实际打的实例；只挂一个模型版本徽标(训练产物时间戳)，
    门控参数与 /health 全部字段都在它的悬浮提示里 */
function VisionGateStartItem({ status, error }: { status: VisionGateStatus | null; error: string | null }) {
  const down = !!error || (status != null && status.enabled && !status.reachable);
  const cls = down ? "down" : status ? (status.enabled && status.reachable ? "ok" : "") : "";
  return (
    <div className={`cfg-start-item ${cls}`}>
      <span className="cfg-start-name">🚦 vision_gate (BERT)</span>
      {error ? (
        <span className="cfg-start-status" data-tip={`agent_server 状态接口失败: ${error}`}>● 不可达</span>
      ) : status ? (
        <>
          {status.reachable ? (
            <span className="cfg-start-status ok">● 在线{status.enabled ? "" : "（门控已关，服务仍在）"}</span>
          ) : status.enabled ? (
            <span className="cfg-start-status" data-tip={status.error ?? ""}>● 不可达</span>
          ) : (
            <span className="cfg-start-status" data-tip={status.error ?? "vision_gate.enabled=false"}>○ 门控已关</span>
          )}
          {status.base_url && (
            <span className="cfg-start-addr" data-tip="agent_server 当前生效的 vision_gate.base_url（含在线覆盖），即对话真正在打的实例">
              {hostPortOf(status.base_url)}
            </span>
          )}
          {status.started_at && (
            <span className="cfg-start-time" data-tip="BERT 服务进程最近一次启动时间（北京时间）">
              启动于 {formatStartedAt(status.started_at)}
            </span>
          )}
          {status.health && (
            <span className="cfg-badges cfg-start-badges">
              <span className="cfg-badge model" data-tip={describeGate(status)}>
                模型 {status.model_version ?? "未知"}
              </span>
            </span>
          )}
        </>
      ) : (
        <span className="cfg-start-status">加载中…</span>
      )}
    </div>
  );
}

/** 顶部服务启动时间状态条：一眼看到 voice / agent / console / memory / person 与记忆 GPU 服务、
    视觉门控 BERT 服务是否在线与上次启动 */
function ServiceStartStrip({
  voice,
  agent,
  consoleCfg,
  memory,
  person,
  emb,
  keyExt,
  gate,
  voiceError,
  agentError,
  consoleError,
  memoryError,
  personError,
  embError,
  keyExtError,
  gateError,
}: {
  voice: ServiceConfig | null;
  agent: ServiceConfig | null;
  consoleCfg: ServiceConfig | null;
  memory: ServiceConfig | null;
  person: ServiceConfig | null;
  emb: ServiceConfig | null;
  keyExt: ServiceConfig | null;
  gate: VisionGateStatus | null;
  voiceError: string | null;
  agentError: string | null;
  consoleError: string | null;
  memoryError: string | null;
  personError: string | null;
  embError: string | null;
  keyExtError: string | null;
  gateError: string | null;
}) {
  const items: {
    key: string;
    icon: string;
    title: string;
    data: ServiceConfig | null;
    error: string | null;
  }[] = [
    { key: "voice", icon: "🎙️", title: "voice_server", data: voice, error: voiceError },
    { key: "agent", icon: "🤖", title: "agent_server", data: agent, error: agentError },
    { key: "console", icon: "🖥️", title: "console_server", data: consoleCfg, error: consoleError },
    { key: "memory", icon: "🧠", title: "family_memory", data: memory, error: memoryError },
    { key: "person", icon: "👁️", title: "person_id", data: person, error: personError },
    { key: "emb", icon: "🧮", title: "embedding", data: emb, error: embError },
    { key: "keyext", icon: "🗝️", title: "key-extractor", data: keyExt, error: keyExtError },
  ];

  const renderItem = ({ key, icon, title, data, error }: (typeof items)[number]) => {
    const addr = data ? formatServiceAddr(data) : null;
    return (
      <div className={`cfg-start-item ${error ? "down" : data ? "ok" : ""}`} key={key}>
        <span className="cfg-start-name">{icon} {title}</span>
        {error ? (
          <span className="cfg-start-status" data-tip={error}>● 不可达</span>
        ) : data ? (
          <>
            <span className="cfg-start-status ok">● 在线</span>
            {addr && (
              <span className="cfg-start-addr" data-tip="本进程服务地址（ip:port）">
                {addr}
              </span>
            )}
            <span className="cfg-start-time" data-tip="本进程最近一次启动时间（北京时间）">
              启动于 {formatStartedAt(data.started_at)}
            </span>
            <span className="cfg-badges cfg-start-badges">
              <span className="cfg-badge">v{data.version}</span>
              <span className="cfg-badge env">env: {data.env}</span>
            </span>
          </>
        ) : (
          <span className="cfg-start-status">加载中…</span>
        )}
      </div>
    );
  };

  /* 视觉门控 BERT 服务紧跟 agent_server（它的唯一调用方）；它没有 /api/config，
     走 agent_server 的状态接口，单独渲染 */
  const gateAfter = items.findIndex((it) => it.key === "agent") + 1;
  return (
    <div className="cfg-start-strip">
      {items.slice(0, gateAfter).map(renderItem)}
      <VisionGateStartItem status={gate} error={gateError} />
      {items.slice(gateAfter).map(renderItem)}
    </div>
  );
}

export function ConfigView() {
  const [voice, setVoice] = useState<ServiceConfig | null>(null);
  const [agent, setAgent] = useState<ServiceConfig | null>(null);
  const [consoleCfg, setConsoleCfg] = useState<ServiceConfig | null>(null);
  const [person, setPerson] = useState<ServiceConfig | null>(null);
  /* family_memory 记忆服务：经 /api/memory 前缀代理，与 voice/agent 同款可编辑体系 */
  const [memory, setMemory] = useState<ServiceConfig | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const [personError, setPersonError] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  /* 记忆 GPU 服务（嵌入/key 抽取）：经 nginx 前缀代理直连各自 /api/config，
     与 voice/agent 同款「拿到配置即在线」探活 */
  const [emb, setEmb] = useState<ServiceConfig | null>(null);
  const [keyExt, setKeyExt] = useState<ServiceConfig | null>(null);
  const [embError, setEmbError] = useState<string | null>(null);
  const [keyExtError, setKeyExtError] = useState<string | null>(null);
  /* 视觉门控 BERT 服务：经 agent_server 探活 + 模型版本，仅状态条展示，无配置卡 */
  const [gate, setGate] = useState<VisionGateStatus | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /* 可编辑白名单（path → 字段状态）。接口不可用时为 null，页面退化为纯只读 */
  const [voiceEditable, setVoiceEditable] = useState<Map<string, EditableField> | null>(null);
  const [agentEditable, setAgentEditable] = useState<Map<string, EditableField> | null>(null);
  const [consoleEditable, setConsoleEditable] = useState<Map<string, EditableField> | null>(null);
  const [personEditable, setPersonEditable] = useState<Map<string, EditableField> | null>(null);
  const [memoryEditable, setMemoryEditable] = useState<Map<string, EditableField> | null>(null);
  /* 保存/恢复后的提示条（非 hot 项提示需要重启） */
  const [notice, setNotice] = useState<string | null>(null);
  /* 各服务的配置卡用 tab 切换展示（并列多卡信息过密）；选中项跨会话记住 */
  const [svcTab, setSvcTab] = useState<ServiceTabKey>(() => {
    const saved = localStorage.getItem("cfgServiceTab");
    return SERVICE_TABS.some((t) => t.key === saved) ? (saved as ServiceTabKey) : "voice";
  });
  const selectSvcTab = useCallback((s: ServiceTabKey) => {
    setSvcTab(s);
    localStorage.setItem("cfgServiceTab", s);
  }, []);

  /* 各请求独立 settle：一边挂掉不影响另一边展示 */
  const load = useCallback(async () => {
    setLoading(true);
    setVoiceError(null);
    setAgentError(null);
    setConsoleError(null);
    setPersonError(null);
    setMemoryError(null);
    setEmbError(null);
    setKeyExtError(null);
    setGateError(null);
    const [v, a, c, p, ve, ae, ce, pe, em, ke, m, me, g] = await Promise.allSettled([
      fetchVoiceConfig(),
      fetchAgentConfig(),
      fetchConsoleConfig(),
      fetchPersonConfig(),
      fetchEditableConfig("voice"),
      fetchEditableConfig("agent"),
      fetchEditableConfig("console"),
      fetchEditableConfig("person"),
      fetchEmbeddingConfig(),
      fetchKeyExtractorConfig(),
      fetchMemoryConfig(),
      fetchEditableConfig("memory"),
      fetchVisionGateStatus(),
    ]);
    if (v.status === "fulfilled") setVoice(v.value);
    else setVoiceError(v.reason?.message || String(v.reason));
    if (a.status === "fulfilled") setAgent(a.value);
    else setAgentError(a.reason?.message || String(a.reason));
    if (c.status === "fulfilled") setConsoleCfg(c.value);
    else setConsoleError(c.reason?.message || String(c.reason));
    if (p.status === "fulfilled") setPerson(p.value);
    else setPersonError(p.reason?.message || String(p.reason));
    setVoiceEditable(ve.status === "fulfilled" ? new Map(ve.value.items.map((f) => [f.path, f])) : null);
    setAgentEditable(ae.status === "fulfilled" ? new Map(ae.value.items.map((f) => [f.path, f])) : null);
    setConsoleEditable(ce.status === "fulfilled" ? new Map(ce.value.items.map((f) => [f.path, f])) : null);
    setPersonEditable(pe.status === "fulfilled" ? new Map(pe.value.items.map((f) => [f.path, f])) : null);
    if (em.status === "fulfilled") setEmb(em.value);
    else setEmbError(em.reason?.message || String(em.reason));
    if (ke.status === "fulfilled") setKeyExt(ke.value);
    else setKeyExtError(ke.reason?.message || String(ke.reason));
    if (m.status === "fulfilled") setMemory(m.value);
    else setMemoryError(m.reason?.message || String(m.reason));
    setMemoryEditable(me.status === "fulfilled" ? new Map(me.value.items.map((f) => [f.path, f])) : null);
    if (g.status === "fulfilled") setGate(g.value);
    else setGateError(g.reason?.message || String(g.reason));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  /* 口令弹窗 + sessionStorage 缓存 + 401 重弹（共享逻辑，与 vision 页 Controls 同一口令缓存） */
  const { withPassword, passwordDialog } = useEditPassword();

  const makeEditCtx = useCallback(
    (service: ConfigService, fields: Map<string, EditableField> | null): EditCtx | undefined => {
      if (!fields) return undefined;
      const serverName = SERVER_NAMES[service];
      return {
        fields,
        onSave: async (path, value) => {
          const r = await withPassword((pw) => putConfigOverride(service, path, value, pw));
          setNotice(r.need_restart
            ? `✅ ${path} 已保存到数据库，重启 ${serverName} 后生效`
            : `✅ ${path} 已保存，立即生效`);
          await syncSettle();
          await load();
          return r;
        },
        onRevert: async (path) => {
          const r = await withPassword((pw) => deleteConfigOverride(service, path, pw));
          setNotice(r.need_restart
            ? `↩️ ${path} 已恢复 yaml 原值，重启 ${serverName} 后生效`
            : `↩️ ${path} 已恢复 yaml 原值，立即生效`);
          await syncSettle();
          await load();
          return r;
        },
      };
    },
    [load, withPassword],
  );

  const voiceEdit = makeEditCtx("voice", voiceEditable);
  const agentEdit = makeEditCtx("agent", agentEditable);
  const consoleEdit = makeEditCtx("console", consoleEditable);
  const personEdit = makeEditCtx("person", personEditable);
  const memoryEdit = makeEditCtx("memory", memoryEditable);

  /* 提示词面板的设备级保存/恢复：与设备覆盖面板同一口令门、同款提示语；
     改完刷新全局视图（「N 台设备覆盖」计数会变）并递增信号让设备覆盖面板重载总览 */
  const [deviceOverrideSignal, setDeviceOverrideSignal] = useState(0);
  const saveAgentDeviceOverride = useCallback(
    async (deviceSn: string, path: string, value: unknown) => {
      const r = await withPassword((pw) => putDeviceConfigOverride("agent", deviceSn, path, value, pw));
      setNotice(`✅ ${path} 已保存为设备 ${deviceSn} 的定向覆盖，仅该设备生效`);
      await syncSettle();
      await load();
      setDeviceOverrideSignal((v) => v + 1);
      return r;
    },
    [load, withPassword],
  );
  const revertAgentDeviceOverride = useCallback(
    async (deviceSn: string, path: string) => {
      const r = await withPassword((pw) => deleteDeviceConfigOverride("agent", deviceSn, path, pw));
      setNotice(`↩️ ${path} 已删除设备 ${deviceSn} 的定向覆盖，回落到全局生效值`);
      await syncSettle();
      await load();
      setDeviceOverrideSignal((v) => v + 1);
      return r;
    },
    [load, withPassword],
  );
  /* 提示词面板的分组级保存/恢复：同款流程，改完递增信号让分组面板重载 */
  const [groupOverrideSignal, setGroupOverrideSignal] = useState(0);
  const saveAgentGroupOverride = useCallback(
    async (group: string, path: string, value: unknown) => {
      const r = await withPassword((pw) => putGroupConfigOverride("agent", group, path, value, pw));
      setNotice(`✅ ${path} 已保存为分组 ${group} 的覆盖，Biz=${group} 的设备下一轮即生效`);
      await syncSettle();
      await load();
      setGroupOverrideSignal((v) => v + 1);
      return r;
    },
    [load, withPassword],
  );
  const revertAgentGroupOverride = useCallback(
    async (group: string, path: string) => {
      const r = await withPassword((pw) => deleteGroupConfigOverride("agent", group, path, pw));
      setNotice(`↩️ ${path} 已删除分组 ${group} 的覆盖，回落到全局生效值`);
      await syncSettle();
      await load();
      setGroupOverrideSignal((v) => v + 1);
      return r;
    },
    [load, withPassword],
  );

  return (
    <div className="cfg-container">
      <div className="cfg-toolbar">
        <span className="cfg-hint">
          各服务当前生效的运行配置（YAML + 环境变量 + 在线编辑覆盖合并后的结果），密钥类字段已脱敏；
          带 ✏️ 的项可在线编辑（需口令，存数据库），「恢复默认」即删除覆盖、回到 yaml 原值
        </span>
        <button className="roster-refresh" onClick={load} disabled={loading}>
          {loading ? <span className="spinner inline" /> : "🔄 刷新"}
        </button>
      </div>
      <ServiceStartStrip
        voice={voice}
        agent={agent}
        consoleCfg={consoleCfg}
        memory={memory}
        person={person}
        emb={emb}
        keyExt={keyExt}
        gate={gate}
        voiceError={voiceError}
        agentError={agentError}
        consoleError={consoleError}
        memoryError={memoryError}
        personError={personError}
        embError={embError}
        keyExtError={keyExtError}
        gateError={gateError}
      />
      <div className="cfg-notice-anchor">
        {notice && <div className="cfg-notice">{notice}</div>}
      </div>
      {passwordDialog}
      <DeviceOverridePanel
        withPassword={withPassword}
        setNotice={setNotice}
        onGlobalReload={load}
        refreshSignal={deviceOverrideSignal}
      />
      <ConfigGroupPanel
        withPassword={withPassword}
        setNotice={setNotice}
        onGlobalReload={load}
        refreshSignal={groupOverrideSignal}
      />
      <PromptsPanel
        editFields={agentEditable ?? undefined}
        onSaveOverride={agentEdit?.onSave}
        onRevertOverride={agentEdit?.onRevert}
        memoryEditFields={memoryEditable ?? undefined}
        onSaveMemoryOverride={memoryEdit?.onSave}
        onRevertMemoryOverride={memoryEdit?.onRevert}
        onSaveDeviceOverride={saveAgentDeviceOverride}
        onRevertDeviceOverride={revertAgentDeviceOverride}
        onSaveGroupOverride={saveAgentGroupOverride}
        onRevertGroupOverride={revertAgentGroupOverride}
      />
      <div className="cfg-service-tabs">
        {SERVICE_TABS.map((t) => (
          <button
            key={t.key}
            className={`cfg-service-tab ${svcTab === t.key ? "active" : ""}`}
            onClick={() => selectSvcTab(t.key)}
          >
            <span className="cfg-service-tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>
      <div className="cfg-grid">
        {svcTab === "voice" && (
          <ServiceCard
            icon="🎙️"
            title="voice_server"
            subtitle="语音接入：ASR / TTS / VAD / 设备通道"
            data={voice}
            error={voiceError}
            loading={loading}
            edit={voiceEdit}
          />
        )}
        {svcTab === "agent" && (
          <ServiceCard
            icon="🤖"
            title="agent_server"
            subtitle="对话智能体：LLM / 意图 / 记忆"
            data={agent}
            error={agentError}
            loading={loading}
            hideSections={["prompt"]}
            edit={agentEdit}
          />
        )}
        {svcTab === "console" && (
          <ServiceCard
            icon="🖥️"
            title="console_server"
            subtitle="web 控制台后端：日志聚合入库 / 对话实时 SSE / 控制请求转发"
            data={consoleCfg}
            error={consoleError}
            loading={loading}
            edit={consoleEdit}
          />
        )}
        {svcTab === "memory" && (
          <ServiceCard
            icon="🧠"
            title="family_memory"
            subtitle="记忆抽取服务：按游标读会话库 → 抽取 LLM / 嵌入 → 独立记忆库；voice 经 notify/tick/flush 触发"
            data={memory}
            error={memoryError}
            loading={loading}
            edit={memoryEdit}
          />
        )}
        {svcTab === "person" && (
          <ServiceCard
            icon="👁️"
            title="person_id"
            subtitle="视觉识别：检测 / 追踪 / 底库匹配 / 拉流"
            data={person}
            error={personError}
            loading={loading}
            edit={personEdit}
          />
        )}
        {/* 记忆 GPU 服务：配置是进程启动时的冻结快照（yaml + 机器本地 config_local.yaml），
            不支持在线编辑——改端口/模型本就需要重启，临时覆盖走远端 config_local.yaml */}
        {svcTab === "emb" && (
          <ServiceCard
            icon="🧮"
            title="embedding-service"
            subtitle="记忆召回查询侧嵌入（Qwen3-Embedding，只读：改配置需改 yaml 并重启）"
            data={emb}
            error={embError}
            loading={loading}
          />
        )}
        {svcTab === "keyext" && (
          <ServiceCard
            icon="🗝️"
            title="key-extractor"
            subtitle="记忆召回 key 抽取（双塔微调，只读：改配置需改 yaml 并重启）"
            data={keyExt}
            error={keyExtError}
            loading={loading}
          />
        )}
      </div>
    </div>
  );
}
