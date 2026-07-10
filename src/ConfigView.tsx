import { useState, useEffect, useCallback } from "react";
import { fetchVoiceConfig, fetchAgentConfig, type ServiceConfig } from "./api";
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

/** 单个配置值的渲染：脱敏值、布尔、长文本、数组、嵌套对象各有形态 */
function ConfigValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="cfg-null">-</span>;
  }
  if (value === "***") {
    return <span className="cfg-masked" title="敏感字段，后端已脱敏">🔒 已脱敏</span>;
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
          <div className="cfg-row" key={k}>
            <span className="cfg-key">{k}</span>
            <ConfigValue value={v} />
          </div>
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
}: {
  icon: string;
  title: string;
  subtitle: string;
  data: ServiceConfig | null;
  error: string | null;
  loading: boolean;
}) {
  const scalarEntries = data
    ? Object.entries(data.config).filter(([, v]) => !isPlainObject(v) && !Array.isArray(v))
    : [];
  const sectionEntries = data
    ? Object.entries(data.config).filter(([, v]) => isPlainObject(v) || Array.isArray(v))
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
                  <div className="cfg-row" key={k}>
                    <span className="cfg-key">{k}</span>
                    <ConfigValue value={v} />
                  </div>
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
                <ConfigValue value={v} />
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

export function ConfigView() {
  const [voice, setVoice] = useState<ServiceConfig | null>(null);
  const [agent, setAgent] = useState<ServiceConfig | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* 两个服务独立请求：一边挂掉不影响另一边展示 */
  const load = useCallback(async () => {
    setLoading(true);
    setVoiceError(null);
    setAgentError(null);
    const [v, a] = await Promise.allSettled([fetchVoiceConfig(), fetchAgentConfig()]);
    if (v.status === "fulfilled") setVoice(v.value);
    else setVoiceError(v.reason?.message || String(v.reason));
    if (a.status === "fulfilled") setAgent(a.value);
    else setAgentError(a.reason?.message || String(a.reason));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="cfg-container">
      <div className="cfg-toolbar">
        <span className="cfg-hint">
          两个服务当前生效的运行配置（YAML + 环境变量合并后的结果），密钥类字段已脱敏
        </span>
        <button className="roster-refresh" onClick={load} disabled={loading}>
          {loading ? <span className="spinner inline" /> : "🔄 刷新"}
        </button>
      </div>
      <div className="cfg-grid">
        <ServiceCard
          icon="🎙️"
          title="voice_server"
          subtitle="语音接入：ASR / TTS / VAD / 设备通道"
          data={voice}
          error={voiceError}
          loading={loading}
        />
        <ServiceCard
          icon="🤖"
          title="agent_server"
          subtitle="对话智能体：LLM / 意图 / 记忆"
          data={agent}
          error={agentError}
          loading={loading}
        />
      </div>
    </div>
  );
}
