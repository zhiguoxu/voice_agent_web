/**
 * person_id 拉流并发监控：同时开着多少路人脸识别视频流。
 *
 * 一路拉流 = 一条持续占 GPU 的识别管线，路数就是 person_id 的负载；开流入口
 * 分散（voice 唤醒/连接联动、控制台、人脸注册、重启恢复），这里把"此刻开着
 * 哪几路、谁拉起的、开了多久、租约还剩多少"和"最近 N 分钟的并发峰值与启停
 * 抖动"放到一处。数据直连 person_id（/person_id 代理），与本页其余区块
 * （voice_server 流量）互不影响：person_id 不可达只在本区块内提示。
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchStreamConcurrency,
  fetchStreamList,
  type StreamConcurrencySample,
  type StreamListData,
  type StreamListItem,
} from "./api";
import { TrendChart, KPI } from "./SweepMonitor";
import "./StreamConcurrency.css";

/** 列表要看到租约倒计时与连接态变化，比分钟桶趋势图刷得勤一些 */
const POLL_MS = 5_000;

const C_RUN = "#6c63ff";
const C_CONN = "#34d399";
const C_START = "#60a5fa";
const C_STOP = "#fbbf24";

const hhmm = (s: string) => s.slice(11, 16);

function fmtDuration(sec: number): string {
  if (sec < 0) sec = 0;
  if (sec < 60) return `${Math.floor(sec)} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.floor(sec % 60)} 秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h} 小时 ${m} 分`;
}

/** "consume/start 接口(lease_seconds=60) <- voice_server/wake_keeper:start(trigger=wake)"
 *  → 表格里只显示 "<- " 之后上游自报的来源，完整串放 tooltip */
function callerOf(source: string | null): string {
  if (!source) return "—";
  const i = source.lastIndexOf("<- ");
  return i >= 0 ? source.slice(i + 3) : source;
}

function stateOf(s: StreamListItem): { cls: string; text: string } {
  if (s.connected) return { cls: "on", text: "已连上" };
  if (s.recovering) return { cls: "warn", text: "自动重推流中" };
  return { cls: "off", text: "未连上（重连中）" };
}

function leaseOf(s: StreamListItem, now: number): string {
  if (s.lease_deadline == null) return "永久";
  const left = s.lease_deadline - now;
  return left <= 0 ? "已到期（待看门狗关流）" : `剩余 ${fmtDuration(left)}`;
}

export function StreamConcurrencySection({ minutes }: { minutes: number }) {
  const [list, setList] = useState<StreamListData | null>(null);
  const [samples, setSamples] = useState<StreamConcurrencySample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const load = useCallback(async () => {
    try {
      const [l, c] = await Promise.all([fetchStreamList(), fetchStreamConcurrency(minutes)]);
      setList(l);
      setSamples(c.items ?? []);
      setNow(Date.now() / 1000);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [minutes]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const times = samples.map((s) => hhmm(s.minute));
  const peakRunning = samples.reduce((a, s) => Math.max(a, s.peak_running), 0);
  const peakConnected = samples.reduce((a, s) => Math.max(a, s.peak_connected), 0);
  const totalStarts = samples.reduce((a, s) => a + s.starts, 0);
  const totalStops = samples.reduce((a, s) => a + s.stops, 0);

  const running = list?.running ?? 0;
  const connected = list?.connected ?? 0;
  // 开着却没连上 = 占着管线不产出识别（设备没推流 / 地址失效重连中），标黄提醒
  const runTone = list == null ? undefined : running > connected ? "warn" : running > 0 ? "ok" : undefined;

  return (
    <>
      <h3 className="stream-section-title">
        person_id 拉流并发
        <small>同时开着几路人脸识别视频流（一路 = 一台设备的服务端拉流 + 识别管线）</small>
      </h3>

      {error && (
        <div className="sweep-error">
          person_id 拉流状态加载失败（服务不可达或代理未配置 /person_id）：{error}
        </div>
      )}

      <div className="sweep-kpis">
        <KPI label="当前拉流路数"
             value={list ? String(running) : "—"}
             sub={list ? `其中已连上视频流 ${connected} 路` : undefined}
             tone={runTone} />
        <KPI label="窗口内并发峰值"
             value={samples.length ? String(peakRunning) : "—"}
             sub={samples.length ? `已连上峰值 ${peakConnected} 路` : undefined} />
        <KPI label="窗口内开流次数"
             value={samples.length ? String(totalStarts) : "—"}
             sub="含 URL 变更停旧起新、重启恢复" />
        <KPI label="窗口内停流次数"
             value={samples.length ? String(totalStops) : "—"}
             sub="显式停止、租约到期、应用关闭" />
      </div>

      <div className="stream-table-wrap">
        {list == null ? (
          <div className="stream-empty">{error ? "无数据" : "加载中…"}</div>
        ) : list.items.length === 0 ? (
          <div className="stream-empty">当前没有任何设备在拉流</div>
        ) : (
          <table className="stream-table">
            <thead>
              <tr>
                <th>设备 (camera_id)</th>
                <th>状态</th>
                <th>环境</th>
                <th>已开启</th>
                <th>发起方</th>
                <th>租约</th>
                <th>观看端</th>
                <th>处理帧率</th>
                <th>分辨率</th>
                <th>重推</th>
                <th>最近错误</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((s) => {
                const st = stateOf(s);
                return (
                  <tr key={s.camera_id}>
                    <td><code>{s.camera_id}</code></td>
                    <td><span className={`stream-state ${st.cls}`}>{st.text}</span></td>
                    <td>{s.env}</td>
                    <td>{s.started_at != null ? fmtDuration(now - s.started_at) : "—"}</td>
                    <td className="stream-source" title={s.start_source ?? undefined}>
                      <code>{callerOf(s.start_source)}</code>
                    </td>
                    <td>{leaseOf(s, now)}</td>
                    <td>{s.viewers}</td>
                    <td>{s.connected ? `${s.process_fps.toFixed(1)} fps` : "—"}</td>
                    <td>{s.stream_width > 0 ? `${s.stream_width}×${s.stream_height}` : "—"}</td>
                    <td>{s.restream_count}</td>
                    <td className={s.last_error ? "err" : ""}>{s.last_error ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <TrendChart
        title="同时拉流路数（每分钟峰值）"
        hint="拉流中 = 该分钟内同时在消费的最大路数；已连上 = 其中真正收到视频帧的最大路数，两条线长期分开说明有设备开了流却没推上来。每 5s 采样一次，最右一个点是当前未走完的分钟"
        times={times}
        format={(v) => v.toFixed(0)}
        series={[
          { label: "拉流中", color: C_RUN, values: samples.map((s) => s.peak_running) },
          { label: "已连上", color: C_CONN, values: samples.map((s) => s.peak_connected) },
        ]}
      />
      <TrendChart
        title="每分钟开流 / 停流次数"
        hint="开流 = 消费器登记（接口开流、URL 变更停旧起新、重启恢复），停流 = 注销（显式停止、租约到期、应用关闭）。持续成对出现是唤醒联动在反复开关或地址在反复失效"
        times={times}
        format={(v) => v.toFixed(0)}
        series={[
          { label: "开流", color: C_START, values: samples.map((s) => s.starts) },
          { label: "停流", color: C_STOP, values: samples.map((s) => s.stops) },
        ]}
      />
    </>
  );
}
