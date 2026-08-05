/**
 * MiniMax TTS 访问频次监控。
 *
 * 数据来自后端 Redis 分钟桶（所有 voice 实例全局累加，重启不清零）：
 * MiniMax 按请求频率限流，限流时表现是合成任务被拒、设备端"没声音"，
 * 对话侧毫无痕迹——靠这张图看访问量是否在逼近配额，以及突刺出现在几点。
 *
 * 两个口径：
 * - 文本请求（task_continue）：攒句后逐句发送，对应"请求频率"限流维度，头号指标；
 * - 建连（WebSocket + task_start）：每次合成新建一条连接，对应"并发任务"维度。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchTtsMetrics, type TtsMinuteSample } from "./api";
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

const hhmm = (s: string) => s.slice(11, 16);

export function TtsMonitor() {
  const [minutes, setMinutes] = useState(60);
  const [items, setItems] = useState<TtsMinuteSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchTtsMetrics(minutes);
      setItems(data.items ?? []);
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

  const times = useMemo(() => items.map((s) => hhmm(s.minute)), [items]);
  // 末桶是当前尚未走完的分钟，读数还会涨；KPI 的"上一分钟"取最后一个完整桶
  const current = items[items.length - 1];
  const lastFull = items[items.length - 2];
  const peakReq = Math.max(0, ...items.map((s) => s.requests));
  const peakConn = Math.max(0, ...items.map((s) => s.connects));
  const totalReq = items.reduce((a, s) => a + s.requests, 0);
  const totalConn = items.reduce((a, s) => a + s.connects, 0);

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
          <div className="sweep-kpis">
            <KPI label="上一分钟文本请求"
                 value={lastFull ? String(lastFull.requests) : "—"}
                 sub={lastFull ? `建连 ${lastFull.connects} 次` : "窗口内无完整分钟"} />
            <KPI label="当前分钟（进行中）"
                 value={current ? String(current.requests) : "—"}
                 sub={current ? `建连 ${current.connects} 次，读数仍在累计` : undefined} />
            <KPI label="窗口内峰值 / 分钟"
                 value={String(peakReq)}
                 sub={`建连峰值 ${peakConn} 次/分`} />
            <KPI label="窗口总量"
                 value={String(totalReq)}
                 sub={`建连合计 ${totalConn} 次`} />
          </div>

          <TrendChart
            title="MiniMax TTS 每分钟访问次数"
            hint="文本请求 = 攒句后逐句发送的 task_continue，对应 MiniMax 的请求频率限流维度；建连 = 每次合成新建的 WebSocket 任务，对应并发任务维度。最右一个点是当前未走完的分钟，读数还会涨"
            times={times}
            format={(v) => v.toFixed(0)}
            series={[
              { label: "文本请求", color: C_REQ, values: items.map((s) => s.requests) },
              { label: "建连", color: C_CONN, values: items.map((s) => s.connects) },
            ]}
          />
        </>
      )}
    </div>
  );
}
