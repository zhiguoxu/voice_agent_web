import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchVoiceConfig,
  fetchAgentConfig,
  fetchConsoleConfig,
  fetchPersonConfig,
  fetchEditableConfig,
  putConfigOverride,
  deleteConfigOverride,
  fetchDeviceOverrideSummary,
  fetchDeviceEditableConfig,
  putDeviceConfigOverride,
  deleteDeviceConfigOverride,
  fetchSessions,
  searchDevices,
  fetchEmbeddingConfig,
  fetchKeyExtractorConfig,
  type ServiceConfig,
  type ConfigService,
  type EditableField,
  type DeviceEditableField,
  type DeviceOverrideSummaryItem,
  type HttpError,
  type OverrideMutationResult,
} from "./api";
import { PromptsPanel } from "./PromptsPanel";
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
  { key: "person", icon: "👁️", label: "person_id" },
  { key: "emb", icon: "🧮", label: "embedding" },
  { key: "keyext", icon: "🗝️", label: "key-extractor" },
];

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
   llm.name 的候选须与 LLMConfig 的方案字段(doubao/gemini)保持一致，
   后端 validator 也会拦，但下拉让操作者根本不用记方案名 */
const ENUM_OPTIONS: Record<string, string[]> = {
  "asr.name": ["xiaodu", "azure"],
  "tts.name": ["minimax", "azure"],
  "llm.name": ["doubao", "gemini"],
  // 摄像头自动拉流：与 AutoStreamConfig 的 Literal 取值保持一致
  "auto_stream.mode": ["connection", "wake"],
  "auto_stream.env": ["test", "prod"],
  // person_id (视觉识别) 的模型选择字段
  "face.recognition_backend": ["arcface", "adaface"],
  "gallery.ediffiqa_enroll_variant": ["tiny", "small", "medium", "large"],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* ── 在线编辑（DB 覆盖层）──
   编辑后的值存数据库并立即生效（非 hot 项重启后生效）；「恢复默认」删除
   数据库覆盖、回到 yaml 原值。全部叶子配置可编辑（后端锁定项除外），
   保存/恢复前需输入编辑口令（后端校验，口令在本浏览器标签页内记住）。 */

const PW_STORAGE_KEY = "cfg-edit-password";

export type SaveOverrideFn = (path: string, value: unknown) => Promise<OverrideMutationResult>;
export type RevertOverrideFn = (path: string) => Promise<OverrideMutationResult>;

interface EditCtx {
  fields: Map<string, EditableField>;
  onSave: SaveOverrideFn;
  onRevert: RevertOverrideFn;
  /** 设备级面板传入：行徽标切到「设备覆盖 / 跟随全局修改」三层值来源 */
  deviceFields?: Map<string, DeviceEditableField>;
}

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
            <option value={o} key={o}>{o}</option>
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
  onEdit,
  onRevert,
}: {
  field: EditableField;
  deviceField?: DeviceEditableField;
  onEdit: () => void;
  onRevert: () => Promise<void>;
}) {
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
              data-tip={`此值仅对本设备生效。全局生效值: ${deviceField.sensitive ? "***" : previewValue(deviceField.global_value)}`}
            >
              设备覆盖
            </span>
          ) : globalModified ? (
            <span
              className="cfg-badge modified"
              data-tip={`本设备无定向覆盖，跟随全局在线修改的值。yaml 原值: ${previewValue(deviceField.baseline)}`}
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
        </>
      )}
      <button
        className="cfg-edit-btn"
        data-tip={
          deviceField
            ? ((deviceField.description || "为该设备设置定向覆盖值") +
              "；只对该设备生效，改完该设备下一轮请求即用新值")
            : ((field.description || "在线编辑此配置项（存数据库，可随时恢复默认）") +
              (field.hot ? "" : "；保存后需重启对应服务生效"))
        }
        onClick={onEdit}
      >✏️</button>
      {(deviceField ? deviceField.overridden : field.overridden) && (
        <button
          className="cfg-edit-btn revert"
          data-tip={deviceField ? "删除该设备的定向覆盖，回落到全局生效值" : "删除数据库里的覆盖值，恢复 yaml 原值"}
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

/** 配置分级表格：顶层标量归入「基础参数」，每个顶层对象/数组单独成段（全局卡与设备级面板共用） */
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

  return (
    <>
      {scalarEntries.length > 0 && (
        <div className="cfg-section">
          <h4 className="cfg-section-title">基础参数</h4>
          <div className="cfg-rows">
            {scalarEntries.map(([k, v]) => (
              <ConfigRow name={k} value={v} path={k} edit={edit} key={k} />
            ))}
          </div>
        </div>
      )}

      {sectionEntries.map(([k, v]) => (
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
}: {
  withPassword: WithPasswordFn;
  setNotice: (msg: string) => void;
  /** 保存/删除设备覆盖后刷新全局视图（「N 台设备覆盖」计数会变） */
  onGlobalReload: () => Promise<void>;
}) {
  /* 有覆盖的设备总览（两服务合并计数） */
  const [summary, setSummary] = useState<Map<string, DeviceOverrideSummaryItem>>(new Map());
  /* 选择器候选：最近有会话的设备 + 总览里出现的设备 */
  const [candidates, setCandidates] = useState<{ sn: string; name: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [fields, setFields] = useState<Partial<Record<ConfigService, DeviceEditableField[]>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* 可搜索组合框：不输入时列出候选，输入即按名称/SN 模糊搜索
     （走后端全量设备档案与历史会话设备，不限于本地候选） */
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ sn: string; name: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [comboOpen, setComboOpen] = useState(false);
  const comboRef = useRef<HTMLSpanElement>(null);
  /* 两个服务(voice/agent)的设备级配置用 tab 切换展示, 与上方全局配置卡一致 */
  const [svcTab, setSvcTab] = useState<ConfigService>("voice");

  const loadOverview = useCallback(async () => {
    const [v, a, sessions] = await Promise.allSettled([
      fetchDeviceOverrideSummary("voice"),
      fetchDeviceOverrideSummary("agent"),
      fetchSessions({ page_size: 50 }),
    ]);
    const merged = new Map<string, DeviceOverrideSummaryItem>();
    for (const r of [v, a]) {
      if (r.status !== "fulfilled") continue;
      for (const d of r.value.devices) {
        const prev = merged.get(d.device_sn);
        merged.set(d.device_sn, {
          device_sn: d.device_sn,
          name: d.name || prev?.name || "",
          override_count: (prev?.override_count ?? 0) + d.override_count,
        });
      }
    }
    setSummary(merged);

    const seen = new Map<string, string>();
    if (sessions.status === "fulfilled") {
      for (const s of sessions.value.items) {
        if (!seen.has(s.device_sn)) seen.set(s.device_sn, s.device_name || "");
      }
    }
    for (const d of merged.values()) {
      if (!seen.has(d.device_sn)) seen.set(d.device_sn, d.name);
    }
    setCandidates([...seen.entries()].map(([sn, name]) => ({ sn, name })));
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

  /* 防抖搜索：后端按名称/SN 模糊匹配（覆盖全部设备档案与历史会话设备），
     本地候选同步过滤兜底（后端不可达时至少能搜下拉里已有的） */
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const lower = q.toLowerCase();
      const merged = new Map<string, string>();
      for (const d of candidates) {
        if (d.sn.toLowerCase().includes(lower) || d.name.toLowerCase().includes(lower)) {
          merged.set(d.sn, d.name);
        }
      }
      try {
        for (const d of await searchDevices(q)) {
          merged.set(d.device_sn, d.name || merged.get(d.device_sn) || "");
        }
      } catch {
        /* 后端搜索失败时静默降级为本地候选过滤 */
      }
      setSearchResults([...merged.entries()].map(([sn, name]) => ({ sn, name })));
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, candidates]);

  /* 点组合框外部关闭下拉 */
  useEffect(() => {
    if (!comboOpen) return;
    const onDown = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setComboOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [comboOpen]);

  const afterMutation = useCallback(async () => {
    await Promise.all([loadDevice(selected, { silent: true }), loadOverview(), onGlobalReload()]);
  }, [loadDevice, loadOverview, onGlobalReload, selected]);

  const deviceLabel = (sn: string, name: string) => (name ? `${name} (${sn})` : sn);

  /* 组合框列表：不输入时列全部候选，输入后换成搜索结果 */
  const comboOptions = query.trim() ? (searchResults ?? []) : candidates;
  const selectedName =
    candidates.find((d) => d.sn === selected)?.name ||
    summary.get(selected)?.name ||
    searchResults?.find((d) => d.sn === selected)?.name ||
    "";

  return (
    <div className="card cfg-card">
      <h3>
        📟 设备级配置覆盖
        <span className="subtitle">只对选中设备生效的定向修改（优先级最高），其他设备不受影响；仅热生效字段支持</span>
      </h3>

      <div className="cfg-device-toolbar">
        <label>
          选择设备：
          <span className="cfg-device-combo" ref={comboRef}>
            <input
              type="text"
              value={comboOpen ? query : selected ? deviceLabel(selected, selectedName) : ""}
              onFocus={() => { setQuery(""); setComboOpen(true); }}
              onChange={(e) => { setQuery(e.target.value); setComboOpen(true); }}
              onKeyDown={(e) => e.key === "Escape" && setComboOpen(false)}
              placeholder={comboOpen
                ? "输入设备名称或 SN 模糊搜索，或从列表点选"
                : "点击选择设备（可输入名称/SN 搜索）"}
            />
            {selected && !comboOpen && (
              <button
                className="cfg-device-combo-clear"
                data-tip="清除选择"
                onClick={() => { setSelected(""); setQuery(""); }}
              >×</button>
            )}
            {comboOpen && (
              <div className="cfg-device-combo-list">
                {searching && <div className="cfg-device-combo-empty"><span className="spinner inline" /> 搜索中…</div>}
                {!searching && comboOptions.length === 0 && (
                  <div className="cfg-device-combo-empty">
                    {query.trim() ? `没有匹配「${query.trim()}」的设备（名称与 SN 均未命中）` : "暂无候选设备，输入名称或 SN 搜索"}
                  </div>
                )}
                {!searching && comboOptions.map((d) => (
                  <button
                    className={`cfg-device-combo-option ${d.sn === selected ? "active" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setSelected(d.sn); setQuery(""); setComboOpen(false); }}
                    key={d.sn}
                  >
                    <span className="cfg-device-combo-name">{d.name || d.sn}</span>
                    {d.name && <span className="cfg-device-combo-sn">{d.sn}</span>}
                    {(summary.get(d.sn)?.override_count ?? 0) > 0 && (
                      <span className="cfg-device-combo-count">{summary.get(d.sn)!.override_count} 条覆盖</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </span>
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
              items.map((f) => [f.path, { ...f, hot: true, device_override_count: 0 }]),
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

/** 编辑口令弹窗：promise 化调用（askPassword() 返回用户输入），Enter 确认、取消即拒绝 */
function PasswordDialog({
  hint,
  onSubmit,
  onCancel,
}: {
  hint: string;
  onSubmit: (pw: string) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  return (
    <div className="cfg-pw-overlay" onClick={onCancel}>
      <div className="cfg-pw-dialog" onClick={(e) => e.stopPropagation()}>
        <h4>🔑 编辑口令</h4>
        <p className="cfg-pw-hint">{hint}</p>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pw) onSubmit(pw);
            if (e.key === "Escape") onCancel();
          }}
          placeholder="请输入口令"
        />
        <div className="cfg-edit-actions">
          <button className="cfg-edit-save" onClick={() => pw && onSubmit(pw)} disabled={!pw}>确认</button>
          <button className="cfg-edit-cancel" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  );
}

/** 顶部服务启动时间状态条：一眼看到 voice / agent / console / person 与记忆 GPU 服务是否在线与上次启动 */
function ServiceStartStrip({
  voice,
  agent,
  consoleCfg,
  person,
  emb,
  keyExt,
  voiceError,
  agentError,
  consoleError,
  personError,
  embError,
  keyExtError,
}: {
  voice: ServiceConfig | null;
  agent: ServiceConfig | null;
  consoleCfg: ServiceConfig | null;
  person: ServiceConfig | null;
  emb: ServiceConfig | null;
  keyExt: ServiceConfig | null;
  voiceError: string | null;
  agentError: string | null;
  consoleError: string | null;
  personError: string | null;
  embError: string | null;
  keyExtError: string | null;
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
    { key: "person", icon: "👁️", title: "person_id", data: person, error: personError },
    { key: "emb", icon: "🧮", title: "embedding", data: emb, error: embError },
    { key: "keyext", icon: "🗝️", title: "key-extractor", data: keyExt, error: keyExtError },
  ];

  return (
    <div className="cfg-start-strip">
      {items.map(({ key, icon, title, data, error }) => {
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
      })}
    </div>
  );
}

export function ConfigView() {
  const [voice, setVoice] = useState<ServiceConfig | null>(null);
  const [agent, setAgent] = useState<ServiceConfig | null>(null);
  const [consoleCfg, setConsoleCfg] = useState<ServiceConfig | null>(null);
  const [person, setPerson] = useState<ServiceConfig | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const [personError, setPersonError] = useState<string | null>(null);
  /* 记忆 GPU 服务（嵌入/key 抽取）：经 nginx 前缀代理直连各自 /api/config，
     与 voice/agent 同款「拿到配置即在线」探活 */
  const [emb, setEmb] = useState<ServiceConfig | null>(null);
  const [keyExt, setKeyExt] = useState<ServiceConfig | null>(null);
  const [embError, setEmbError] = useState<string | null>(null);
  const [keyExtError, setKeyExtError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /* 可编辑白名单（path → 字段状态）。接口不可用时为 null，页面退化为纯只读 */
  const [voiceEditable, setVoiceEditable] = useState<Map<string, EditableField> | null>(null);
  const [agentEditable, setAgentEditable] = useState<Map<string, EditableField> | null>(null);
  const [personEditable, setPersonEditable] = useState<Map<string, EditableField> | null>(null);
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
    setEmbError(null);
    setKeyExtError(null);
    const [v, a, c, p, ve, ae, pe, em, ke] = await Promise.allSettled([
      fetchVoiceConfig(),
      fetchAgentConfig(),
      fetchConsoleConfig(),
      fetchPersonConfig(),
      fetchEditableConfig("voice"),
      fetchEditableConfig("agent"),
      fetchEditableConfig("person"),
      fetchEmbeddingConfig(),
      fetchKeyExtractorConfig(),
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
    setPersonEditable(pe.status === "fulfilled" ? new Map(pe.value.items.map((f) => [f.path, f])) : null);
    if (em.status === "fulfilled") setEmb(em.value);
    else setEmbError(em.reason?.message || String(em.reason));
    if (ke.status === "fulfilled") setKeyExt(ke.value);
    else setKeyExtError(ke.reason?.message || String(ke.reason));
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

  /* 口令弹窗（promise 化）：口令记在 sessionStorage（本标签页有效），401 时清掉重弹 */
  const [pwPrompt, setPwPrompt] = useState<{
    hint: string;
    resolve: (pw: string) => void;
    reject: (e: Error) => void;
  } | null>(null);

  const askPassword = useCallback((hint: string) => {
    return new Promise<string>((resolve, reject) => {
      setPwPrompt({ hint, resolve, reject });
    });
  }, []);

  /* 给编辑请求包上口令：无缓存先弹窗要，口令错(401)清缓存重弹，其余错误原样抛给编辑框展示 */
  const withPassword = useCallback(
    async <T,>(call: (pw: string) => Promise<T>): Promise<T> => {
      let pw = sessionStorage.getItem(PW_STORAGE_KEY)
        ?? await askPassword("修改配置需要口令验证（保存在本标签页，关闭后需重新输入）");
      for (;;) {
        try {
          const result = await call(pw);
          sessionStorage.setItem(PW_STORAGE_KEY, pw);
          return result;
        } catch (e) {
          if ((e as HttpError).status === 401) {
            sessionStorage.removeItem(PW_STORAGE_KEY);
            pw = await askPassword("口令错误，请重新输入");
            continue;
          }
          throw e;
        }
      }
    },
    [askPassword],
  );

  const makeEditCtx = useCallback(
    (service: ConfigService, fields: Map<string, EditableField> | null): EditCtx | undefined => {
      if (!fields) return undefined;
      const serverName =
        service === "voice" ? "voice_server" : service === "agent" ? "agent_server" : "person_id";
      return {
        fields,
        onSave: async (path, value) => {
          const r = await withPassword((pw) => putConfigOverride(service, path, value, pw));
          setNotice(r.need_restart
            ? `✅ ${path} 已保存到数据库，重启 ${serverName} 后生效`
            : `✅ ${path} 已保存，立即生效`);
          await load();
          return r;
        },
        onRevert: async (path) => {
          const r = await withPassword((pw) => deleteConfigOverride(service, path, pw));
          setNotice(r.need_restart
            ? `↩️ ${path} 已恢复 yaml 原值，重启 ${serverName} 后生效`
            : `↩️ ${path} 已恢复 yaml 原值，立即生效`);
          await load();
          return r;
        },
      };
    },
    [load, withPassword],
  );

  const voiceEdit = makeEditCtx("voice", voiceEditable);
  const agentEdit = makeEditCtx("agent", agentEditable);
  const personEdit = makeEditCtx("person", personEditable);

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
        person={person}
        emb={emb}
        keyExt={keyExt}
        voiceError={voiceError}
        agentError={agentError}
        consoleError={consoleError}
        personError={personError}
        embError={embError}
        keyExtError={keyExtError}
      />
      <div className="cfg-notice-anchor">
        {notice && <div className="cfg-notice">{notice}</div>}
      </div>
      {pwPrompt && (
        <PasswordDialog
          hint={pwPrompt.hint}
          onSubmit={(pw) => { pwPrompt.resolve(pw); setPwPrompt(null); }}
          onCancel={() => { pwPrompt.reject(new Error("已取消")); setPwPrompt(null); }}
        />
      )}
      <DeviceOverridePanel
        withPassword={withPassword}
        setNotice={setNotice}
        onGlobalReload={load}
      />
      <PromptsPanel
        editFields={agentEditable ?? undefined}
        onSaveOverride={agentEdit?.onSave}
        onRevertOverride={agentEdit?.onRevert}
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
