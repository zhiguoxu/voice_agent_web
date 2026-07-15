import { useState, useEffect, useCallback } from "react";
import { fetchPrompts, type PromptTemplateInfo } from "./api";
import "./ConfigView.css";

/* source_kind → 徽标文案：帮助非开发同学分清「改配置就能调」和「要改代码发版」 */
const SOURCE_KIND_LABELS: Record<string, string> = {
  yaml: "YAML 配置",
  code: "代码内置",
};

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

/** 单个提示词模板：折叠条目，展开后是说明 + 占位符表 + 正文（模板/渲染后可切换） */
function PromptItem({ p }: { p: PromptTemplateInfo }) {
  const [view, setView] = useState<"template" | "rendered">("template");
  const showRendered = view === "rendered" && p.rendered != null;
  const text = showRendered ? p.rendered! : p.template;

  return (
    <details className="cfg-prompt-item">
      <summary>
        <span className="cfg-prompt-title">{p.title}</span>
        <code className="cfg-section-key">{p.key}</code>
        <span className="cfg-prompt-summary-badges">
          <span className={`cfg-badge kind-${p.source_kind}`}>
            {SOURCE_KIND_LABELS[p.source_kind] || p.source_kind}
          </span>
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

        <div className="cfg-prompt-source">
          来源: <code>{p.source}</code>
        </div>
      </div>
    </details>
  );
}

/** 提示词配置面板：汇总展示 agent_server 用到的全部 LLM 提示词模板（只读） */
export function PromptsPanel() {
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
          当前生效的全部 LLM 提示词模板（对话 / 动作表情 / 记忆 / 日程），只读
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
          {prompts.map((p) => (
            <PromptItem p={p} key={p.key} />
          ))}
        </div>
      )}
    </div>
  );
}
