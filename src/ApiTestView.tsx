/**
 * API 测试页：BERT 意图识别、内容风控、火山引擎 ASR 等与生产同款链路的在线探测。
 * 从系统配置拆出，避免把「测接口」和「改配置」混在同一页。
 */
import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchIntentLabels,
  classifyIntent,
  testModeration,
  fetchAsrTestConfig,
  testAsr,
  type IntentLabels,
  type IntentClassifyResult,
  type ModerationTestResult,
  type AsrTestConfig,
  type AsrTestResult,
} from "./api";
import "./ApiTestView.css";

/** BERT 意图识别：label_map 展示 + 在线分类（走生产同款客户端与过滤规则） */
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

/** 风控在线测试：规则层正则 + 风控模型，两层结果分别展示。
 *  走 voice_server /api/moderation/test，风控总开关关着也能测。 */
function ModerationPanel() {
  const [replyText, setReplyText] = useState("");
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<
    { replyText: string; query: string; history: string; r: ModerationTestResult }[]
  >([]);

  const runTest = async () => {
    const text = replyText.trim();
    if (!text || testing) return;
    setTesting(true);
    setError(null);
    try {
      const r = await testModeration(text, query.trim(), history.trim());
      setResults((prev) =>
        [{ replyText: text, query: query.trim(), history: history.trim(), r }, ...prev].slice(0, 20));
      setReplyText("");
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="card cfg-card cfg-intent-card">
      <h3>
        🛡️ 内容风控测试
        <span className="subtitle">
          规则层 + 风控模型双层审核，与生产守卫同一套审核函数（不落库、不打断播报）
        </span>
      </h3>

      <div className="cfg-intent-test cfg-mod-test">
        <input
          type="text"
          placeholder="机器人回复（要审核的文本，可以是半截），如：台湾不是中国的一部分"
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runTest()}
          disabled={testing}
        />
        <input
          type="text"
          className="cfg-mod-query"
          placeholder="用户问题（可选，给模型的上下文）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runTest()}
          disabled={testing}
        />
        <button onClick={runTest} disabled={testing || !replyText.trim()}>
          {testing ? <span className="spinner inline" /> : "审核"}
        </button>
      </div>
      <textarea
        className="cfg-mod-history"
        placeholder={"最近对话（可选，生产送审会自动附带最近几轮，格式每行一句）：\n用户: 我们玩接龙\n机器人: 好呀好呀"}
        rows={2}
        value={history}
        onChange={(e) => setHistory(e.target.value)}
        disabled={testing}
      />
      {error && <div className="cfg-error">❌ 审核失败: {error}</div>}

      {results.length > 0 && (
        <div className="cfg-intent-results">
          {results.map((item, i) => {
            const { r } = item;
            return (
              <div className="cfg-intent-result cfg-mod-result" key={results.length - i}>
                <div className="cfg-mod-head">
                  <span className="cfg-intent-query">“{item.replyText}”</span>
                  {item.query && (
                    <span className="cfg-mod-ctx">（用户问题：{item.query}）</span>
                  )}
                  {item.history && (
                    <span className="cfg-mod-ctx" title={item.history}>
                      （含 {item.history.split("\n").length} 行最近对话）
                    </span>
                  )}
                  <span className={`cfg-badge hit ${r.final.risky ? "down" : "ok"}`}>
                    {r.final.risky ? `⛔ 有风险 · ${r.final.source}` : "✔ 无风险"}
                  </span>
                  {!r.enabled && (
                    <span className="cfg-badge modified">风控开关当前关闭</span>
                  )}
                </div>
                <div className="cfg-mod-layers">
                  <span className="cfg-mod-layer">
                    规则层（{r.rule.rule_count} 条）:{" "}
                    {r.rule.hit ? (
                      <>命中 <code>{r.rule.pattern}</code></>
                    ) : (
                      "未命中"
                    )}
                  </span>
                  <span className="cfg-mod-layer">
                    模型层:{" "}
                    {!r.llm.checked ? (
                      "未配置风控模型"
                    ) : r.llm.error ? (
                      <>调用失败（生产按无风险放行）: {r.llm.error}</>
                    ) : r.llm.risky ? (
                      "判定有风险"
                    ) : (
                      "判定无风险"
                    )}
                    {r.llm.elapsed_ms != null && (
                      <span className="cfg-mod-elapsed">
                        {" "}· 首token {r.llm.ttft_ms ?? "?"}ms / 总 {r.llm.elapsed_ms}ms
                      </span>
                    )}
                    {r.llm.model && <code className="cfg-mod-model">{r.llm.model}</code>}
                  </span>
                  {r.llm.raw_output != null && (
                    <span className="cfg-mod-layer">
                      模型输出: <code className="cfg-mod-raw">{r.llm.raw_output}</code>
                      {!r.llm.risky && r.llm.raw_output.startsWith("0") && (
                        <span className="cfg-mod-elapsed">（首token 即结论，已提前断流）</span>
                      )}
                    </span>
                  )}
                </div>
                {r.final.risky && r.final.replacement && (
                  <div className="cfg-mod-replacement">
                    替代话术：{r.final.replacement}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 火山引擎 ASR 在线测试：上传音频（对话详情/原始音频弹窗下载的 WAV 均可），
 *  走生产同款 VolcengineASR 客户端（含热词），三种模式按次可选，不改全局配置。 */
function AsrPanel() {
  const [cfg, setCfg] = useState<AsrTestConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [cfgLoading, setCfgLoading] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState("");
  const [realtime, setRealtime] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AsrTestResult[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadConfig = useCallback(async () => {
    setCfgLoading(true);
    setCfgError(null);
    try {
      setCfg(await fetchAsrTestConfig());
    } catch (e: any) {
      setCfgError(e.message || String(e));
    } finally {
      setCfgLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const runTest = async () => {
    if (!file || testing) return;
    setTesting(true);
    setError(null);
    try {
      const r = await testAsr(file, mode, realtime);
      setResults((prev) => [r, ...prev].slice(0, 20));
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="card cfg-card cfg-intent-card">
      <h3>
        🎙️ 火山引擎 ASR 测试
        <span className="subtitle">
          上传音频跑生产同款流式识别（含热词），可选三种模式，不落库、不触发对话
        </span>
        {cfg && (
          <span className="cfg-badges">
            <span className={`cfg-badge health ${cfg.api_key_configured ? "ok" : "down"}`}>
              {cfg.api_key_configured ? "● api_key 已配置" : "● api_key 未配置"}
            </span>
            {cfg.provider !== "volcengine" && (
              <span className="cfg-badge modified">生产当前 ASR: {cfg.provider}</span>
            )}
          </span>
        )}
        <button className="roster-refresh" onClick={loadConfig} disabled={cfgLoading}>
          {cfgLoading ? <span className="spinner inline" /> : "🔄 刷新"}
        </button>
      </h3>

      {cfgError && <div className="cfg-error">❌ 加载配置失败: {cfgError}</div>}

      {cfg && (
        <div className="cfg-intent-meta">
          <span>默认模式 <code>{cfg.default_mode}</code></span>
          <span>资源 <code>{cfg.resource_id}</code></span>
          <span>输入采样率 <code>{cfg.input_sample_rate} Hz</code>（其他采样率的 WAV 自动转换）</span>
          <span>
            热词{" "}
            {cfg.hot_words.length > 0 ? (
              <code>{cfg.hot_words.join("、")}</code>
            ) : (
              "（无）"
            )}
          </span>
        </div>
      )}

      <div className="cfg-intent-test cfg-asr-test">
        <input
          ref={fileInputRef}
          type="file"
          accept=".wav,.pcm,.raw,audio/wav,audio/x-wav"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={testing}
        />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          disabled={testing}
          title="识别模式，仅本次生效，不改全局配置"
        >
          <option value="">跟随配置{cfg ? `（${cfg.default_mode}）` : ""}</option>
          <option value="bigmodel">bigmodel（双向流式）</option>
          <option value="bigmodel_async">bigmodel_async（流式优化版，官方推荐）</option>
          <option value="bigmodel_nostream">bigmodel_nostream（句级出结果，无中间结果）</option>
        </select>
        <label
          className="cfg-asr-realtime"
          title="按 200ms 实时节奏喂入，模拟生产时序（耗时≈音频时长），latency 才有生产参考意义"
        >
          <input
            type="checkbox"
            checked={realtime}
            onChange={(e) => setRealtime(e.target.checked)}
            disabled={testing}
          />
          实时节奏喂入
        </label>
        <button onClick={runTest} disabled={testing || !file}>
          {testing ? <span className="spinner inline" /> : "识别"}
        </button>
      </div>
      <div className="cfg-asr-tip">
        支持对话详情下载的「输入语音」和原始音频弹窗下载的 WAV（16-bit PCM，任意采样率/声道），
        以及裸 PCM（按 16kHz 单声道 int16 解释）。
      </div>
      {error && <div className="cfg-error">❌ 识别失败: {error}</div>}

      {results.length > 0 && (
        <div className="cfg-intent-results">
          {results.map((r, i) => (
            <div className="cfg-intent-result cfg-mod-result" key={results.length - i}>
              <div className="cfg-mod-head">
                <span className="cfg-intent-query">{r.filename || "（未命名文件）"}</span>
                <span className="cfg-badge">{r.mode}</span>
                {r.realtime && <span className="cfg-badge modified">实时节奏</span>}
                <span className={`cfg-badge hit ${r.text ? "ok" : "down"}`}>
                  {r.text ? "✔ 有结果" : "✘ 无结果/超时"}
                </span>
              </div>
              <div className="cfg-asr-text">
                {r.text ?? "（未识别出文本）"}
              </div>
              <div className="cfg-mod-layers">
                <span className="cfg-mod-layer">
                  音频 <span className="cfg-number">{r.audio_seconds.toFixed(2)}s</span>
                </span>
                <span className="cfg-mod-layer">
                  尾包延迟 <span className="cfg-number">{r.latency_ms}ms</span>
                  {!r.realtime && (
                    <span className="cfg-mod-elapsed">（全速喂入，无生产参考意义）</span>
                  )}
                </span>
                <span className="cfg-mod-layer">
                  总耗时 <span className="cfg-number">{r.elapsed_ms}ms</span>
                </span>
                <span className="cfg-mod-layer">
                  中间结果 <span className="cfg-number">{r.mid_texts.length}</span> 条
                </span>
              </div>
              {r.mid_texts.length > 0 && (
                <details className="cfg-asr-mid">
                  <summary>
                    中间结果（最后一条：{r.mid_texts[r.mid_texts.length - 1].text}）
                  </summary>
                  <div className="cfg-asr-mid-list">
                    {r.mid_texts.map((m, j) => (
                      <div key={j}>
                        <span className="cfg-number">{(m.t_ms / 1000).toFixed(2)}s</span> {m.text}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ApiTestView() {
  return (
    <div className="api-test-container">
      <div className="api-test-hint">
        在线 API 探测：与生产链路同一套客户端与规则，结果不落库、不影响线上播报。
      </div>
      <IntentPanel />
      <ModerationPanel />
      <AsrPanel />
    </div>
  );
}
