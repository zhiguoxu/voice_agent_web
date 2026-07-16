import { useState, useEffect, useCallback } from "react";
import {
  fetchPrompts,
  type PromptTemplateInfo,
  type EditableField,
  type OverrideMutationResult,
} from "./api";
import "./ConfigView.css";

/* source_kind → 徽标文案：帮助非开发同学分清「改配置就能调」和「要改代码发版」 */
const SOURCE_KIND_LABELS: Record<string, string> = {
  yaml: "YAML 配置",
  code: "代码内置",
};

type SaveOverrideFn = (path: string, value: unknown) => Promise<OverrideMutationResult>;
type RevertOverrideFn = (path: string) => Promise<OverrideMutationResult>;

/** 模板正文渲染：把程序占位符高亮成色块，其余文本原样输出 */
function TemplateText({ text, placeholders }: { text: string; placeholders: string[] }) {
  if (placeholders.length === 0) {
    return <pre className="cfg-prompt-pre">{text}</pre>;
  }
  const escaped = placeholders.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "g");
  return (
    <pre className="cfg-prompt-pre">
      {text.split(re).map((part, i) =>
        placeholders.includes(part)
          ? <mark className="cfg-ph" key={i}>{part}</mark>
          : part
      )}
    </pre>
  );
}

/** 提示词模板编辑器：textarea + 保存/取消，校验失败原样展示后端报错 */
function PromptEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (e: any) {
      setError(e.message || String(e));
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div className="cfg-edit-box prompt">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(24, Math.max(8, draft.split("\n").length + 2))}
        disabled={saving}
      />
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

/** 单个提示词模板：折叠条目，展开后是说明 + 占位符表 + 正文（模板/渲染后可切换）。
    命中可编辑白名单（prompt.{key}）的模板可在线编辑，编辑后的值存数据库。 */
function PromptItem({
  p,
  editField,
  onSave,
  onRevert,
}: {
  p: PromptTemplateInfo;
  editField?: EditableField;
  onSave?: (value: string) => Promise<void>;
  onRevert?: () => Promise<void>;
}) {
  const [view, setView] = useState<"template" | "rendered">("template");
  const [editing, setEditing] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const showRendered = view === "rendered" && p.rendered != null;
  const text = showRendered ? p.rendered! : p.template;
  const editable = editField != null && onSave != null;

  const revert = async () => {
    if (!onRevert || reverting) return;
    setReverting(true);
    setRevertError(null);
    try {
      await onRevert();
    } catch (e: any) {
      setRevertError(e.message || String(e));
    }
    setReverting(false);
  };

  return (
    <details className="cfg-prompt-item">
      <summary>
        <span className="cfg-prompt-title">{p.title}</span>
        <code className="cfg-section-key">{p.key}</code>
        <span className="cfg-prompt-summary-badges">
          <span className={`cfg-badge kind-${p.source_kind}`}>
            {SOURCE_KIND_LABELS[p.source_kind] || p.source_kind}
          </span>
          {editField?.overridden && (
            <span className="cfg-badge modified" data-tip="已被在线编辑覆盖，可在展开后「恢复默认」回到 yaml 原值">
              已修改
            </span>
          )}
          {p.model && <span className="cfg-badge model">{p.model}</span>}
          <span className="cfg-prompt-len">{p.template.length} 字符</span>
        </span>
      </summary>

      <div className="cfg-prompt-body">
        <p className="cfg-prompt-usage">{p.usage}</p>

        {p.placeholders.length > 0 && (
          <div className="cfg-prompt-placeholders">
            {p.placeholders.map((ph) => (
              <div className="cfg-prompt-placeholder" key={ph.name}>
                <mark className="cfg-ph">{ph.name}</mark>
                <span>{ph.note}</span>
              </div>
            ))}
          </div>
        )}

        {editable && !editing && (
          <div className="cfg-prompt-editbar">
            <button className="cfg-edit-save" onClick={() => setEditing(true)}>
              ✏️ 编辑模板
            </button>
            {editField.overridden && (
              <button
                className="cfg-edit-cancel"
                onClick={revert}
                disabled={reverting}
                data-tip="删除数据库里的覆盖值，恢复 yaml 原值"
              >
                {reverting ? <span className="spinner inline" /> : "↺ 恢复默认"}
              </button>
            )}
            {revertError && <span className="cfg-error inline">❌ {revertError}</span>}
          </div>
        )}

        {editing && onSave ? (
          <PromptEditor
            initial={p.template}
            onSave={async (v) => {
              await onSave(v);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            {p.rendered != null && (
              <div className="cfg-prompt-viewtabs">
                <button
                  className={view === "template" ? "active" : ""}
                  onClick={() => setView("template")}
                >
                  模板原文
                </button>
                <button
                  className={view === "rendered" ? "active" : ""}
                  onClick={() => setView("rendered")}
                >
                  渲染后（实际下发）
                </button>
              </div>
            )}

            <TemplateText
              text={text}
              placeholders={showRendered ? [] : p.placeholders.map((ph) => ph.name)}
            />
          </>
        )}

        <div className="cfg-prompt-source">
          来源: <code>{p.source}</code>
          {editField?.overridden && <span className="cfg-prompt-override-note">（当前生效的是数据库覆盖值）</span>}
        </div>
      </div>
    </details>
  );
}

/** 提示词配置面板：汇总展示 agent_server 用到的全部 LLM 提示词模板。
    yaml 来源且在可编辑白名单里的模板支持在线编辑（配置 DB 覆盖层）。 */
export function PromptsPanel({
  editFields,
  onSaveOverride,
  onRevertOverride,
}: {
  /** agent_server 可编辑白名单（path → 字段状态）；未提供时面板纯只读 */
  editFields?: Map<string, EditableField>;
  onSaveOverride?: SaveOverrideFn;
  onRevertOverride?: RevertOverrideFn;
}) {
  const [prompts, setPrompts] = useState<PromptTemplateInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPrompts(await fetchPrompts());
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="card cfg-card cfg-prompt-card">
      <h3>
        📝 提示词配置
        <span className="subtitle">
          当前生效的全部 LLM 提示词模板（对话 / 动作表情 / 记忆 / 日程），YAML 来源的可在线编辑
        </span>
        {prompts && <span className="cfg-badges"><span className="cfg-badge">{prompts.length} 个模板</span></span>}
        <button className="roster-refresh" onClick={load} disabled={loading}>
          {loading ? <span className="spinner inline" /> : "🔄 刷新"}
        </button>
      </h3>

      {error && <div className="cfg-error">❌ 加载失败: {error}</div>}
      {loading && !prompts && !error && (
        <div className="empty"><div className="spinner" /></div>
      )}

      {prompts && (
        <div className="cfg-prompt-list">
          {prompts.map((p) => {
            const path = `prompt.${p.key}`;
            const editField = editFields?.get(path);
            return (
              <PromptItem
                p={p}
                key={p.key}
                editField={editField}
                onSave={
                  editField && onSaveOverride
                    ? async (v) => { await onSaveOverride(path, v); await load(); }
                    : undefined
                }
                onRevert={
                  editField && onRevertOverride
                    ? async () => { await onRevertOverride(path); await load(); }
                    : undefined
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
