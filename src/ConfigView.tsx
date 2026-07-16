import { useState, useEffect, useCallback } from "react";
import {
  fetchVoiceConfig,
  fetchAgentConfig,
  fetchEditableConfig,
  putConfigOverride,
  deleteConfigOverride,
  fetchIntentLabels,
  classifyIntent,
  type ServiceConfig,
  type ConfigService,
  type EditableField,
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
   数据库覆盖、回到 yaml 原值。可编辑范围由后端白名单决定。 */

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

/** 行内编辑器：标量用 input / 布尔用下拉 / 列表与长文本用 textarea */
function FieldEditor({
  field,
  onSave,
  onCancel,
}: {
  field: EditableField;
  onSave: (value: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => valueToDraft(field.value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sample = field.baseline;
  const multiline =
    Array.isArray(sample) ||
    (typeof sample === "string" && (sample.length > LONG_TEXT_THRESHOLD || sample.includes("\n")));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draftToValue(draft, sample));
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
          placeholder={Array.isArray(sample) ? "一行一条" : ""}
          disabled={saving}
        />
      ) : (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          disabled={saving}
        />
      )}
      {Array.isArray(sample) && <div className="cfg-edit-hint">列表项一行一条，空行忽略</div>}
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
      {!field.hot && <span className="cfg-badge restart" data-tip="该项在服务启动时消费，改完需重启对应服务才生效">重启生效</span>}
      <button className="cfg-edit-btn" data-tip={field.description} onClick={onEdit}>✏️</button>
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

  const makeEditCtx = useCallback(
    (service: ConfigService, fields: Map<string, EditableField> | null): EditCtx | undefined => {
      if (!fields) return undefined;
      const serverName = service === "voice" ? "voice_server" : "agent_server";
      return {
        fields,
        onSave: async (path, value) => {
          const r = await putConfigOverride(service, path, value);
          setNotice(r.need_restart
            ? `✅ ${path} 已保存到数据库，重启 ${serverName} 后生效`
            : `✅ ${path} 已保存，立即生效`);
          await load();
          return r;
        },
        onRevert: async (path) => {
          const r = await deleteConfigOverride(service, path);
          setNotice(r.need_restart
            ? `↩️ ${path} 已恢复 yaml 原值，重启 ${serverName} 后生效`
            : `↩️ ${path} 已恢复 yaml 原值，立即生效`);
          await load();
          return r;
        },
      };
    },
    [load],
  );

  const voiceEdit = makeEditCtx("voice", voiceEditable);
  const agentEdit = makeEditCtx("agent", agentEditable);

  return (
    <div className="cfg-container">
      <div className="cfg-toolbar">
        <span className="cfg-hint">
          两个服务当前生效的运行配置（YAML + 环境变量 + 在线编辑覆盖合并后的结果），密钥类字段已脱敏；
          带 ✏️ 的项可在线编辑（存数据库），「恢复默认」即删除覆盖、回到 yaml 原值
        </span>
        <button className="roster-refresh" onClick={load} disabled={loading}>
          {loading ? <span className="spinner inline" /> : "🔄 刷新"}
        </button>
      </div>
      {notice && <div className="cfg-notice">{notice}</div>}
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
