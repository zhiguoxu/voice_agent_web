/**
 * 外部调用流量监控。
 *
 * 数据来自后端 Redis 分钟桶（所有 voice 实例全局累加，重启不清零），
 * 每个已注册上游一组 KPI + 一张趋势图：
 * - MiniMax / Azure TTS：按请求频率限流，限流时表现是"没声音"且对话侧
 *   毫无痕迹，靠失败线提前看出访问量在逼近配额；
 * - 小度 / Azure ASR：每轮语音一次建连+识别会话，失败线暴露建连超时、
 *   服务端错误与收尾超时；
 * - agent_server 对话：每聊天轮一次，是全链路吞吐的直接读数。
 */
import { useCallback, useEffect, useState } from "react";
import { fetchTrafficMetrics, type TrafficMinuteSample } from "./api";
import { TrendChart, KPI } from "./SweepMonitor";
import "./SweepMonitor.css";

const RANGES = [
  { label: "10 分钟", minutes: 10 },
  { label: "30 分钟", minutes: 30 },
  { label: "1 小时", minutes: 60 },
  { label: "6 小时", minutes: 360 },
  { label: "24 小时", minutes: 1440 },
];
const POLL_MS = 10_000;

const C_REQ = "#6c63ff";
const C_CONN = "#34d399";
const C_ERR = "#f87171";

interface ProviderDef {
  id: string;
  title: string;
  reqLabel: string;
  /** 是否有"建连"口径（TTS/ASR 类有，agent_chat 没有） */
  hasConn: boolean;
  hint: string;
}

/** TTS 双 provider：同一区块内用标签页切换（同一时刻只有一个在生效） */
const TTS_PROVIDERS: ProviderDef[] = [
  {
    id: "minimax_tts",
    title: "MiniMax TTS",
    reqLabel: "文本请求",
    hasConn: true,
    hint: "文本请求 = 攒句后逐句发送的 task_continue，对应 MiniMax 的请求频率限流维度；建连 = 每次合成新建的 WebSocket 任务，对应并发任务维度；失败 = 建连失败 + 服务端错误事件（限流/欠费/审核，代码里静默降级，这条线是唯一暴露口）",
  },
  {
    id: "azure_tts",
    title: "Azure TTS",
    reqLabel: "逐句合成",
    hasConn: true,
    hint: "逐句合成 = 攒句后每句一次 start_speaking 请求；建连 = 每次合成新建的 synthesizer 连接；失败 = 建连失败 + 合成被取消/音频流中断。未启用 azure 时恒为 0",
  },
];

/** ASR 多 provider：同一区块内用标签页切换（同一时刻只有一个在生效） */
const ASR_PROVIDERS: ProviderDef[] = [
  {
    id: "xiaodu_asr",
    title: "小度 ASR",
    reqLabel: "识别会话",
    hasConn: true,
    hint: "识别会话 = 每轮语音一次 finish_stream；建连 = 每次识别新建的 WebSocket + START 帧；失败 = 建连/START 失败 + 服务端错误事件 + 等待最终结果超时。未启用 xiaodu 时恒为 0",
  },
  {
    id: "azure_asr",
    title: "Azure ASR",
    reqLabel: "识别会话",
    hasConn: true,
    hint: "识别会话 = 每轮语音一次 finish_stream；建连 = 每次识别启动的连续识别会话；失败 = 启动失败 + SDK canceled(Error) + 等待最终结果超时。未启用 azure 时恒为 0",
  },
  {
    id: "volcengine_asr",
    title: "火山引擎 ASR",
    reqLabel: "识别会话",
    hasConn: true,
    hint: "识别会话 = 每轮语音一次 finish_stream；建连 = 每次识别新建的 WebSocket + full client request；失败 = 建连失败 + 服务端错误帧 + 等待最终结果超时。未启用 volcengine 时恒为 0",
  },
];

const AGENT_PROVIDER: ProviderDef = {
  id: "agent_chat",
  title: "agent_server 对话",
  reqLabel: "请求",
  hasConn: false,
  hint: "每聊天轮恰好一次 SSE 请求，是全链路吞吐的直接读数；失败 = HTTP 错误 / 连不上 / 回复流超时 / 传输中断",
};

const ALL_PROVIDERS = [...TTS_PROVIDERS, ...ASR_PROVIDERS, AGENT_PROVIDER];

const hhmm = (s: string) => s.slice(11, 16);

export function TrafficMonitor() {
  const [minutes, setMinutes] = useState(60);
  const [ttsProvider, setTtsProvider] = useState(TTS_PROVIDERS[0].id);
  const [asrProvider, setAsrProvider] = useState(ASR_PROVIDERS[0].id);
  const [data, setData] = useState<Record<string, TrafficMinuteSample[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const results = await Promise.all(
        ALL_PROVIDERS.map((u) => fetchTrafficMetrics(u.id, minutes)));
      setData(Object.fromEntries(results.map((r) => [r.provider, r.items ?? []])));
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [minutes]);

  useEffect(() => {
    setLoading(true);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="sweep-monitor">
      <div className="sweep-toolbar">
        <div className="sweep-ranges">
          {RANGES.map((r) => (
            <button key={r.minutes}
                    className={`sweep-range ${minutes === r.minutes ? "active" : ""}`}
                    onClick={() => setMinutes(r.minutes)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="sweep-meta">
          <span data-tip="所有 voice 实例的访问累加在同一套 Redis 分钟桶里，这里看到的是全局值">
            全实例合计
          </span>
          {updatedAt && <span>更新于 {updatedAt.toLocaleTimeString("zh-CN")}</span>}
          <button className="sweep-refresh" onClick={load} data-tip="立即刷新">↻</button>
        </div>
      </div>

      {error && <div className="sweep-error">加载失败：{error}</div>}

      {loading ? (
        <div className="sweep-empty">加载中…</div>
      ) : (
        <>
          {/* TTS 区块：双 provider 同一时刻只有一个在生效，标签页切换不并排铺开 */}
          <div className="sweep-ranges" style={{ marginTop: 4 }}>
            {TTS_PROVIDERS.map((u) => (
              <button key={u.id}
                      className={`sweep-range ${ttsProvider === u.id ? "active" : ""}`}
                      onClick={() => setTtsProvider(u.id)}>
                {u.title}
              </button>
            ))}
          </div>
          {TTS_PROVIDERS.filter((u) => u.id === ttsProvider).map((u) => (
            <ProviderSection key={u.id} provider={u} items={data[u.id] ?? []} />
          ))}

          {/* ASR 区块：与 TTS 同结构，标签页切换 */}
          <div className="sweep-ranges" style={{ marginTop: 4 }}>
            {ASR_PROVIDERS.map((u) => (
              <button key={u.id}
                      className={`sweep-range ${asrProvider === u.id ? "active" : ""}`}
                      onClick={() => setAsrProvider(u.id)}>
                {u.title}
              </button>
            ))}
          </div>
          {ASR_PROVIDERS.filter((u) => u.id === asrProvider).map((u) => (
            <ProviderSection key={u.id} provider={u} items={data[u.id] ?? []} />
          ))}

          <ProviderSection provider={AGENT_PROVIDER}
                           items={data[AGENT_PROVIDER.id] ?? []} />
        </>
      )}
    </div>
  );
}

function ProviderSection({ provider, items }: {
  provider: ProviderDef;
  items: TrafficMinuteSample[];
}) {
  const times = items.map((s) => hhmm(s.minute));
  // 末桶是当前尚未走完的分钟，读数还会涨；KPI 的"上一分钟"取最后一个完整桶
  const current = items[items.length - 1];
  const lastFull = items[items.length - 2];
  const totalReq = items.reduce((a, s) => a + (s.requests ?? 0), 0);
  const totalConn = items.reduce((a, s) => a + (s.connects ?? 0), 0);
  const totalErr = items.reduce((a, s) => a + (s.errors ?? 0), 0);

  const series = [
    { label: provider.reqLabel, color: C_REQ,
      values: items.map((s) => s.requests ?? 0) },
    ...(provider.hasConn
      ? [{ label: "建连", color: C_CONN, values: items.map((s) => s.connects ?? 0) }]
      : []),
    { label: "失败", color: C_ERR, values: items.map((s) => s.errors ?? 0) },
  ];

  return (
    <>
      <div className="sweep-kpis">
        <KPI label={`${provider.title} · 上一分钟`}
             value={lastFull ? String(lastFull.requests ?? 0) : "—"}
             sub={lastFull && provider.hasConn ? `建连 ${lastFull.connects ?? 0} 次` : undefined} />
        <KPI label="当前分钟（进行中）"
             value={current ? String(current.requests ?? 0) : "—"}
             sub={current ? "读数仍在累计" : undefined} />
        <KPI label="窗口总量"
             value={String(totalReq)}
             sub={provider.hasConn ? `建连合计 ${totalConn} 次` : undefined} />
        <KPI label="窗口内失败"
             value={String(totalErr)}
             tone={totalErr > 0 ? "danger" : "ok"} />
      </div>
      <TrendChart
        title={`${provider.title} · 每分钟访问次数`}
        hint={`${provider.hint}。最右一个点是当前未走完的分钟，读数还会涨`}
        times={times}
        format={(v) => v.toFixed(0)}
        series={series}
      />
    </>
  );
}
