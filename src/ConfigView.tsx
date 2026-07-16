import { useState, useEffect, useCallback } from "react";
import {
  fetchVoiceConfig,
  fetchAgentConfig,
  fetchEditableConfig,
  putConfigOverride,
  deleteConfigOverride,
  fetchDeviceOverrideSummary,
  fetchDeviceEditableConfig,
  putDeviceConfigOverride,
  deleteDeviceConfigOverride,
  fetchSessions,
  fetchIntentLabels,
  classifyIntent,
  type ServiceConfig,
  type ConfigService,
  type EditableField,
  type DeviceEditableField,
  type DeviceOverrideSummaryItem,
  type HttpError,
  type OverrideMutationResult,
  type IntentLabels,
  type IntentClassifyResult,
} from "./api";
import { PromptsPanel } from "./PromptsPanel";
import "./ConfigView.css";

/* 顶层配置段的中文标题：帮助非开发同学快速定位；没收录的段直接显示原始字段名 */
const SECTION_LABELS: Record<string, string> = {
  audio: "音频参数",
  vad: "VAD 语音活动检测",
  asr: "ASR 语音识别",
  tts: "TTS 语音合成",
  wakeup_answers: "唤醒应答语",
  llm: "LLM 对话模型",
  prompt: "提示词模板",
  memory: "记忆系统",
  bert_intent: "BERT 意图识别",
  web_search: "联网搜索",
  person_id: "身份识别",
  mqtt: "MQTT 消息通道",
  redis: "Redis",
  cos: "对象存储 COS",
};

const LONG_TEXT_THRESHOLD = 120;

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
      {typeof sample === "boolean" ? (
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

/** 可编辑行的右侧附加区：编辑按钮 + 「已修改」徽标 + 恢复默认 */
function EditControls({
  field,
  onEdit,
  onRevert,
}: {
  field: EditableField;
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

  return (
    <span className="cfg-edit-controls">
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
      <button
        className="cfg-edit-btn"
        data-tip={
          (field.description || "在线编辑此配置项（存数据库，可随时恢复默认）") +
          (field.hot ? "" : "；保存后需重启对应服务生效")
        }
        onClick={onEdit}
      >✏️</button>
      {field.overridden && (
        <button className="cfg-edit-btn revert" data-tip="删除数据库里的覆盖值，恢复 yaml 原值" onClick={revert} disabled={reverting}>
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
  const scalarEntries = data
    ? Object.entries(data.config).filter(([, v]) => !isPlainObject(v) && !Array.isArray(v))
    : [];
  const sectionEntries = data
    ? Object.entries(data.config).filter(
        ([k, v]) => (isPlainObject(v) || Array.isArray(v)) && !hideSections?.includes(k))
    : [];

  return (
    <div className="card cfg-card">
      <h3>
        {icon} {title}
        <span className="subtitle">{subtitle}</span>
        {data && (
          <span className="cfg-badges">
            <span className="cfg-badge">v{data.version}</span>
            <span className="cfg-badge env">env: {data.env}</span>
          </span>
        )}
      </h3>

      {error && <div className="cfg-error">❌ 加载失败: {error}</div>}
      {loading && !data && !error && (
        <div className="empty"><div className="spinner" /></div>
      )}

      {data && (
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

          <details className="cfg-raw">
            <summary>原始 JSON（已脱敏）</summary>
            <pre>{JSON.stringify(data.config, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  );
}

/** BERT 意图识别面板：label_map 展示 + 在线分类测试（走生产同款客户端与过滤规则） */
function IntentPanel() {
  const [labels, setLabels] = useState<IntentLabels | null>(null);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [labelsLoading, setLabelsLoading] = useState(false);

  const [text, setText] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [results, setResults] = useState<IntentClassifyResult[]>([]);

  const loadLabels = useCallback(async () => {
    setLabelsLoading(true);
    setLabelsError(null);
    try {
      setLabels(await fetchIntentLabels());
    } catch (e: any) {
      setLabelsError(e.message || String(e));
    } finally {
      setLabelsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLabels();
  }, [loadLabels]);

  const runClassify = async () => {
    const query = text.trim();
    if (!query || classifying) return;
    setClassifying(true);
    setTestError(null);
    try {
      const r = await classifyIntent(query);
      setResults((prev) => [r, ...prev].slice(0, 20));
      setText("");
    } catch (e: any) {
      setTestError(e.message || String(e));
    } finally {
      setClassifying(false);
    }
  };

  const sortedLabels = labels
    ? Object.entries(labels.labels).sort(([a], [b]) => Number(a) - Number(b))
    : [];

  return (
    <div className="card cfg-card cfg-intent-card">
      <h3>
        🧠 BERT 意图识别
        <span className="subtitle">label_map 与在线分类测试（与生产链路同一套客户端与过滤规则）</span>
        {labels && (
          <span className="cfg-badges">
            <span className={`cfg-badge health ${labels.healthy ? "ok" : "down"}`}>
              {labels.healthy ? "● 服务在线" : "● 服务不可达"}
            </span>
          </span>
        )}
        <button className="roster-refresh" onClick={loadLabels} disabled={labelsLoading}>
          {labelsLoading ? <span className="spinner inline" /> : "🔄 刷新"}
        </button>
      </h3>

      {labelsError && <div className="cfg-error">❌ 加载失败: {labelsError}</div>}

      {labels && (
        <>
          <div className="cfg-intent-meta">
            <span>服务地址 <code>{labels.base_url}</code></span>
            <span>置信度阈值 <code>{labels.confidence_threshold}</code></span>
            <span>类别数 <code>{labels.count}</code></span>
          </div>

          <h4 className="cfg-section-title">
            类别映射
            <span className="cfg-section-key">
              label id 与远端模型输出位次一一对应，换模型必须配套更换 label_map.csv
            </span>
          </h4>
          <div className="cfg-intent-labels">
            {sortedLabels.map(([id, name]) => (
              <span className="cfg-intent-label" key={id}>
                <span className="cfg-intent-label-id">{id}</span>
                {name}
              </span>
            ))}
          </div>

          <h4 className="cfg-section-title">在线测试</h4>
          <div className="cfg-intent-test">
            <input
              type="text"
              placeholder="输入一句话，如：向前走 / 讲个故事"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runClassify()}
              disabled={classifying}
            />
            <button onClick={runClassify} disabled={classifying || !text.trim()}>
              {classifying ? <span className="spinner inline" /> : "分类"}
            </button>
          </div>
          {testError && <div className="cfg-error">❌ 分类失败: {testError}</div>}

          {results.length > 0 && (
            <div className="cfg-intent-results">
              {results.map((r, i) => (
                <div className="cfg-intent-result" key={results.length - i}>
                  <span className="cfg-intent-query">“{r.query}”</span>
                  <span className="cfg-intent-arrow">→</span>
                  <span className="cfg-intent-raw">
                    {r.label} <span className="cfg-number">{(r.confidence * 100).toFixed(2)}%</span>
                  </span>
                  <span className={`cfg-badge hit ${r.hit ? "ok" : "down"}`}>
                    {r.hit ? "✔ 命中" : r.label === "other" ? "✘ other" : "✘ 未过阈值"}
                  </span>
                  <span className="cfg-intent-final">
                    最终意图: <code>{r.final_intent}</code>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {labelsLoading && !labels && (
        <div className="empty"><div className="spinner" /></div>
      )}
    </div>
  );
}

/* ── 设备级配置覆盖面板 ──
   只对选中 device_sn 生效的定向配置修改（优先级最高：设备覆盖 > 全局覆盖 > yaml），
   可编辑范围 = hot（热生效）字段。顶部总览列出所有有覆盖的设备（防遗忘入口）。 */

type WithPasswordFn = <T>(call: (pw: string) => Promise<T>) => Promise<T>;

const SERVICE_META: { key: ConfigService; icon: string; title: string }[] = [
  { key: "voice", icon: "🎙️", title: "voice_server" },
  { key: "agent", icon: "🤖", title: "agent_server" },
];

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 设备视图的一行可编辑配置：三层值来源徽标（设备覆盖 / 跟随全局修改 / yaml 原值） */
function DeviceFieldRow({
  field,
  onSave,
  onRevert,
}: {
  field: DeviceEditableField;
  onSave: (value: unknown) => Promise<void>;
  onRevert: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* 复用全局视图的行内编辑器：设备可编辑字段必为 hot */
  const editorField: EditableField = { ...field, hot: true, device_override_count: 0 };
  const globalModified = !field.sensitive && !sameValue(field.global_value, field.baseline);

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

  return (
    <div className="cfg-row editable">
      <span className="cfg-key">{field.path}</span>
      {editing ? (
        <FieldEditor
          field={editorField}
          onSave={async (v) => {
            await onSave(v);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <ConfigValue value={field.value} />
          <span className="cfg-edit-controls">
            {field.overridden ? (
              <span
                className="cfg-badge device-override"
                data-tip={`此值仅对本设备生效。全局生效值: ${field.sensitive ? "***" : previewValue(field.global_value)}`}
              >
                设备覆盖
              </span>
            ) : globalModified ? (
              <span
                className="cfg-badge modified"
                data-tip={`本设备无定向覆盖，跟随全局在线修改的值。yaml 原值: ${previewValue(field.baseline)}`}
              >
                跟随全局修改
              </span>
            ) : null}
            <button
              className="cfg-edit-btn"
              data-tip={
                (field.description || "为该设备设置定向覆盖值") +
                "；只对该设备生效，改完该设备下一轮请求即用新值"
              }
              onClick={() => setEditing(true)}
            >✏️</button>
            {field.overridden && (
              <button
                className="cfg-edit-btn revert"
                data-tip="删除该设备的定向覆盖，回落到全局生效值"
                onClick={revert}
                disabled={reverting}
              >
                {reverting ? <span className="spinner inline" /> : "↺"}
              </button>
            )}
            {error && <span className="cfg-error inline">❌ {error}</span>}
          </span>
        </>
      )}
    </div>
  );
}

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

  const loadDevice = useCallback(async (sn: string) => {
    if (!sn) {
      setFields(null);
      return;
    }
    setLoading(true);
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
    setLoading(false);
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadDevice(selected);
  }, [selected, loadDevice]);

  const afterMutation = useCallback(async () => {
    await Promise.all([loadDevice(selected), loadOverview(), onGlobalReload()]);
  }, [loadDevice, loadOverview, onGlobalReload, selected]);

  const deviceLabel = (sn: string, name: string) => (name ? `${name} (${sn})` : sn);

  return (
    <div className="card cfg-card">
      <h3>
        📟 设备级配置覆盖
        <span className="subtitle">只对选中设备生效的定向修改（优先级最高），其他设备不受影响；仅热生效字段支持</span>
      </h3>

      <div className="cfg-device-toolbar">
        <label>
          选择设备：
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">— 请选择 —</option>
            {candidates.map((d) => (
              <option value={d.sn} key={d.sn}>{deviceLabel(d.sn, d.name)}</option>
            ))}
          </select>
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
          {SERVICE_META.map(({ key, icon, title }) => {
            const items = fields[key];
            if (!items) {
              return (
                <div className="cfg-section" key={key}>
                  <h4 className="cfg-section-title">{icon} {title}</h4>
                  <div className="cfg-error">❌ 该服务的设备配置接口不可用</div>
                </div>
              );
            }
            return (
              <div className="cfg-section" key={key}>
                <h4 className="cfg-section-title">
                  {icon} {title}
                  <span className="cfg-section-key">
                    {items.filter((f) => f.overridden).length} / {items.length} 项被此设备覆盖
                  </span>
                </h4>
                <div className="cfg-rows">
                  {items.map((f) => (
                    <DeviceFieldRow
                      field={f}
                      key={f.path}
                      onSave={async (v) => {
                        await withPassword((pw) =>
                          putDeviceConfigOverride(key, selected, f.path, v, pw));
                        setNotice(`✅ ${f.path} 已保存为设备 ${selected} 的定向覆盖，仅该设备生效`);
                        await afterMutation();
                      }}
                      onRevert={async () => {
                        await withPassword((pw) =>
                          deleteDeviceConfigOverride(key, selected, f.path, pw));
                        setNotice(`↩️ ${f.path} 已删除设备 ${selected} 的定向覆盖，回落到全局生效值`);
                        await afterMutation();
                      }}
                    />
                  ))}
                </div>
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

export function ConfigView() {
  const [voice, setVoice] = useState<ServiceConfig | null>(null);
  const [agent, setAgent] = useState<ServiceConfig | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /* 可编辑白名单（path → 字段状态）。接口不可用时为 null，页面退化为纯只读 */
  const [voiceEditable, setVoiceEditable] = useState<Map<string, EditableField> | null>(null);
  const [agentEditable, setAgentEditable] = useState<Map<string, EditableField> | null>(null);
  /* 保存/恢复后的提示条（非 hot 项提示需要重启） */
  const [notice, setNotice] = useState<string | null>(null);

  /* 各请求独立 settle：一边挂掉不影响另一边展示 */
  const load = useCallback(async () => {
    setLoading(true);
    setVoiceError(null);
    setAgentError(null);
    const [v, a, ve, ae] = await Promise.allSettled([
      fetchVoiceConfig(),
      fetchAgentConfig(),
      fetchEditableConfig("voice"),
      fetchEditableConfig("agent"),
    ]);
    if (v.status === "fulfilled") setVoice(v.value);
    else setVoiceError(v.reason?.message || String(v.reason));
    if (a.status === "fulfilled") setAgent(a.value);
    else setAgentError(a.reason?.message || String(a.reason));
    setVoiceEditable(ve.status === "fulfilled" ? new Map(ve.value.items.map((f) => [f.path, f])) : null);
    setAgentEditable(ae.status === "fulfilled" ? new Map(ae.value.items.map((f) => [f.path, f])) : null);
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
      const serverName = service === "voice" ? "voice_server" : "agent_server";
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

  return (
    <div className="cfg-container">
      <div className="cfg-toolbar">
        <span className="cfg-hint">
          两个服务当前生效的运行配置（YAML + 环境变量 + 在线编辑覆盖合并后的结果），密钥类字段已脱敏；
          带 ✏️ 的项可在线编辑（需口令，存数据库），「恢复默认」即删除覆盖、回到 yaml 原值
        </span>
        <button className="roster-refresh" onClick={load} disabled={loading}>
          {loading ? <span className="spinner inline" /> : "🔄 刷新"}
        </button>
      </div>
      {notice && <div className="cfg-notice">{notice}</div>}
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
      <IntentPanel />
      <PromptsPanel
        editFields={agentEditable ?? undefined}
        onSaveOverride={agentEdit?.onSave}
        onRevertOverride={agentEdit?.onRevert}
      />
      <div className="cfg-grid">
        <ServiceCard
          icon="🎙️"
          title="voice_server"
          subtitle="语音接入：ASR / TTS / VAD / 设备通道"
          data={voice}
          error={voiceError}
          loading={loading}
          edit={voiceEdit}
        />
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
      </div>
    </div>
  );
}
