/**
 * 记忆摄取水位监控。
 *
 * 数据来自后端 memory_sweep_samples：兜底扫描每轮记一行，只有持扫描租约的那
 * 一个实例会写（notify 触发的抽取天然均摊到各实例，不构成瓶颈，不计入）。
 *
 * 头号指标是「吞吐水位」= 本轮排空耗时 / 扫描周期。容量模型要求 R·t < C，
 * 等价于水位 < 1：越线则队列无界增长，对话尾巴的记忆抽取迟早赶不上 30 分钟
 * 的会话切换线，用户下一次开口就召回不到上一段对话——而这在对话侧毫无痕迹，
 * 只能靠这张图提前看出来。故留一半富余（50%）就告警。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchSweepSamples, type SweepSample } from "./api";
import "./SweepMonitor.css";

const RANGES = [
  { label: "1 小时", hours: 1 },
  { label: "6 小时", hours: 6 },
  { label: "24 小时", hours: 24 },
  { label: "3 天", hours: 72 },
  { label: "7 天", hours: 168 },
];
const POLL_MS = 30_000;
/** 与后端 ingest._LOAD_WARN_RATIO 一致：留一半富余就告警 */
const WARN_RATIO = 0.5;

const C_LOAD = "#6c63ff";
const C_WARN = "#fbbf24";
const C_DANGER = "#f87171";
const C_GREEN = "#34d399";
const C_BLUE = "#60a5fa";
const C_GRAY = "#8b93a7";

/* ────────────────────────── 通用折线图 ────────────────────────── */

const W = 600;
const H = 140;

interface Series {
  label: string;
  color: string;
  /** 与 times 等长；null = 该轮无此值（如超载轮没有排空耗时），断线不连 */
  values: (number | null)[];
  /** 只在图例里出数值、不画线：用于与主线成常数倍的派生量（画出来是条贴底的直线） */
  readoutOnly?: boolean;
  /** 该读数自己的格式化（单位与主轴不同时用） */
  format?: (v: number) => string;
}

interface RefLine {
  value: number;
  color: string;
  label: string;
}

/**
 * 手搓 SVG 折线：项目里没有图表库，为这一个面板引一个反而更重。
 * viewBox 固定、宽度 100% 自适应，描边用 non-scaling-stroke 保持线宽。
 *
 * y 轴按数据自适应，不为了容纳参考线而拉大量程：水位常态只有百分之几，
 * 硬把 100% 画进来会把曲线压成一条贴底的直线，趋势全看不见——而「离上限
 * 还有多远」由指标卡的配色回答，图要回答的是「在往哪走」。放不下的参考线
 * 只在图例里标出数值。
 */
function TrendChart({ title, hint, times, series, refLines, format, marks }: {
  title: string;
  hint?: string;
  times: string[];
  series: Series[];
  refLines?: RefLine[];
  format: (v: number) => string;
  /** 需要竖线标出的轮次下标（超载轮） */
  marks?: number[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const lines = useMemo(() => series.filter((s) => !s.readoutOnly), [series]);

  const top = useMemo(() => {
    const vals = lines.flatMap((s) => s.values.filter((v): v is number => v != null));
    const dataMax = Math.max(...vals, 0);
    // 参考线离数据不远才纳入量程，否则它会独占整个 y 轴
    const near = (refLines ?? []).map((r) => r.value).filter((v) => v <= dataMax * 1.4);
    const raw = Math.max(dataMax, ...near);
    return raw > 0 ? raw * 1.15 : 1;
  }, [lines, refLines]);

  const n = times.length;
  const xAt = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const yAt = (v: number) => H - Math.min(v / top, 1.1) * H;

  /** null 处断开，避免把缺口连成一条假线 */
  const paths = (values: (number | null)[]) => {
    const out: string[] = [];
    let cur: string[] = [];
    values.forEach((v, i) => {
      if (v == null) {
        if (cur.length) out.push(cur.join(" "));
        cur = [];
      } else {
        cur.push(`${cur.length ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
      }
    });
    if (cur.length) out.push(cur.join(" "));
    return out;
  };

  const onMove = (e: React.MouseEvent) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || n === 0) return;
    const ratio = (e.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))));
  };

  const idx = hover ?? n - 1;

  return (
    <section className="sweep-chart">
      <div className="sweep-chart-head">
        <h4>{title}{hint && <span className="sweep-hint" data-tip={hint}>?</span>}</h4>
        <div className="sweep-legend">
          {series.map((s) => (
            <span key={s.label} className="sweep-legend-item">
              {!s.readoutOnly && <i style={{ background: s.color }} />}
              {s.label}
              <b>{idx >= 0 && s.values[idx] != null
                    ? (s.format ?? format)(s.values[idx]!) : "—"}</b>
            </span>
          ))}
        </div>
      </div>

      <div className="sweep-plot">
      <span className="sweep-ymax">{format(top)}</span>
      <span className="sweep-ymin">0</span>
      <svg ref={svgRef} className="sweep-svg" viewBox={`0 0 ${W} ${H}`}
           preserveAspectRatio="none"
           onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="sweep-grid" />
        ))}
        {(marks ?? []).map((i) => (
          <line key={`m${i}`} x1={xAt(i)} x2={xAt(i)} y1="0" y2={H}
                stroke={C_DANGER} strokeWidth="1" opacity="0.45"
                vectorEffect="non-scaling-stroke" />
        ))}
        {(refLines ?? []).filter((r) => r.value <= top).map((r) => (
          <line key={r.label} x1="0" x2={W} y1={yAt(r.value)} y2={yAt(r.value)}
                stroke={r.color} strokeWidth="1" strokeDasharray="4 4"
                vectorEffect="non-scaling-stroke" opacity="0.8" />
        ))}
        {lines.map((s) =>
          paths(s.values).map((d, i) => (
            <path key={`${s.label}-${i}`} d={d} fill="none" stroke={s.color}
                  strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"
                  vectorEffect="non-scaling-stroke" />
          )),
        )}
        {hover != null && (
          <line x1={xAt(hover)} x2={xAt(hover)} y1="0" y2={H}
                className="sweep-cursor" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      </div>

      <div className="sweep-axis">
        <span>{times[0] ?? ""}</span>
        {hover != null && <span className="sweep-axis-hover">{times[hover]}</span>}
        <span>{times[n - 1] ?? ""}</span>
      </div>
      {(refLines ?? []).length > 0 && (
        <div className="sweep-reflegend">
          {refLines!.map((r) => (
            <span key={r.label} className={r.value > top ? "off" : ""}>
              <i style={{ background: r.color }} />{r.label}
              {r.value > top && "（远在量程之外，当前很安全）"}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/* ────────────────────────── 面板 ────────────────────────── */

const hhmm = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

/** 水位 = 排空耗时 / 扫描周期；超载轮（没排空就被换代）无值 */
const loadOf = (s: SweepSample) =>
  s.drain_ms == null || !s.interval_sec ? null : s.drain_ms / (s.interval_sec * 1000);

export function SweepMonitor() {
  const [hours, setHours] = useState(6);
  const [items, setItems] = useState<SweepSample[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchSweepSamples(hours);
      setEnabled(data.enabled);
      setItems(data.items ?? []);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    setLoading(true);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const times = useMemo(() => items.map((s) => hhmm(s.created_at)), [items]);
  const last = items[items.length - 1];
  const lastLoad = last ? loadOf(last) : null;
  const overloadRounds = items.filter((s) => s.drain_ms == null).length;
  const peakLoad = Math.max(0, ...items.map((s) => loadOf(s) ?? 0));

  /** 到达率 R = 本轮批数 / 扫描周期（批/分），与容量式 R·t < C 同口径 */
  const rateOf = (s: SweepSample) =>
    s.interval_sec ? s.batches / (s.interval_sec / 60) : 0;

  if (!enabled) {
    return (
      <div className="sweep-monitor">
        <div className="sweep-empty">记忆系统未启用，无水位数据。</div>
      </div>
    );
  }

  return (
    <div className="sweep-monitor">
      <div className="sweep-toolbar">
        <div className="sweep-ranges">
          {RANGES.map((r) => (
            <button key={r.hours}
                    className={`sweep-range ${hours === r.hours ? "active" : ""}`}
                    onClick={() => setHours(r.hours)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="sweep-meta">
          {last && <span data-tip="当时持扫描租约的实例，换人说明发生过接管">
            扫描实例 {last.instance_id.slice(0, 8)}
          </span>}
          {last && <span>周期 {(last.interval_sec / 60).toFixed(0)}min · 并发上限 {last.concurrency}</span>}
          {updatedAt && <span>更新于 {updatedAt.toLocaleTimeString("zh-CN")}</span>}
          <button className="sweep-refresh" onClick={load} data-tip="立即刷新">↻</button>
        </div>
      </div>

      {error && <div className="sweep-error">加载失败：{error}</div>}

      {loading ? (
        <div className="sweep-empty">加载中…</div>
      ) : items.length === 0 ? (
        <div className="sweep-empty">
          这段时间没有采样。兜底扫描每几分钟才一轮，且只有持租约的那一个实例
          会写——刚部署或刚发生租约接管时，需要等一轮才有数据。
        </div>
      ) : (
        <>
          <div className="sweep-kpis">
            <KPI label="最新吞吐水位"
                 value={lastLoad == null ? "超载" : pct(lastLoad)}
                 tone={lastLoad == null || lastLoad >= 1 ? "danger"
                       : lastLoad >= WARN_RATIO ? "warn" : "ok"}
                 sub={`排空 ${last.drain_ms == null ? "未完成" : secs(last.drain_ms)} / 周期 ${(last.interval_sec / 60).toFixed(0)}min`} />
            <KPI label="窗口内峰值水位" value={pct(peakLoad)}
                 tone={peakLoad >= 1 ? "danger" : peakLoad >= WARN_RATIO ? "warn" : "ok"}
                 sub={overloadRounds ? `另有 ${overloadRounds} 轮未排空` : "全部轮次均已排空"} />
            <KPI label="最近一轮批数 N" value={String(last.batches)}
                 sub={`到达率 R≈${rateOf(last).toFixed(1)} 批/分`} />
            <KPI label="最近一轮单批耗时 t"
                 value={last.t_mean_ms == null ? "—" : secs(last.t_mean_ms)}
                 sub={last.t_max_ms == null ? "本轮无批次" : `峰值 ${secs(last.t_max_ms)}（${last.t_count} 批）`} />
            <KPI label="设备 / 候选" value={`${last.devices} / ${last.candidates}`}
                 sub={`规划耗时 ${last.plan_ms}ms（预筛 ${last.prefilter_ms}ms）`} />
          </div>

          <TrendChart
            title="吞吐水位"
            hint="本轮排空耗时 ÷ 扫描周期。稳态要求 R·t < C，等价于水位 < 1；到 1 时队列已无界增长，对话尾巴迟早赶不上 30min 会话切换线。断口=该轮没排空就被下一轮换代"
            times={times}
            format={pct}
            marks={items.flatMap((s, i) => (s.drain_ms == null ? [i] : []))}
            refLines={[
              { value: 1, color: C_DANGER, label: "100% 上限" },
              { value: WARN_RATIO, color: C_WARN, label: "50% 告警线" },
            ]}
            series={[{ label: "水位", color: C_LOAD, values: items.map(loadOf) }]}
          />

          <TrendChart
            title="总处理时间（排空 D）与扫描周期 I"
            hint="D 从本轮开始规划算到最后一批跑完，含并发槽上的排队时间。D 必须显著小于 I，否则下一轮扫描开始时上一轮还没跑完"
            times={times}
            format={secs}
            refLines={last ? [{ value: last.interval_sec * 1000, color: C_DANGER, label: `扫描周期 I=${(last.interval_sec / 60).toFixed(0)}min` }] : []}
            series={[{ label: "排空 D", color: C_BLUE, values: items.map((s) => s.drain_ms) }]}
          />

          <TrendChart
            title="单批耗时 t"
            hint="一批从拿到并发槽算到抽取+写库完成，不含排队。t 变大意味着抽取模型变慢，会直接抬高水位"
            times={times}
            format={secs}
            series={[
              { label: "均值", color: C_GREEN, values: items.map((s) => s.t_mean_ms) },
              { label: "峰值", color: C_WARN, values: items.map((s) => s.t_max_ms) },
            ]}
          />

          <TrendChart
            title="批数 N 与到达率 R"
            hint="N = 本轮真派出的批数，R = N ÷ 扫描周期。R 是需求侧、t 是服务侧，R·t 越过并发上限 C 就开始积压——即水位图上的越线。R 与 N 只差一个常数倍，故只出读数不另画线"
            times={times}
            format={(v) => v.toFixed(0)}
            series={[
              { label: "批数 N", color: C_LOAD, values: items.map((s) => s.batches) },
              { label: "到达率 R", color: C_GREEN, values: items.map(rateOf),
                readoutOnly: true, format: (v) => `${v.toFixed(1)} 批/分` },
            ]}
          />

          <TrendChart
            title="设备数与预筛候选数"
            hint="候选 = 两次批量查（游标管道 + 行 id 聚合）筛掉没新对话的设备后剩下的，只有这批才逐个查库规划。设备总数比候选高两个数量级且变化极慢，同轴画会把候选压成贴底直线，故只出读数"
            times={times}
            format={(v) => v.toFixed(0)}
            series={[
              { label: "预筛候选", color: C_BLUE, values: items.map((s) => s.candidates) },
              { label: "规划出批", color: C_LOAD, values: items.map((s) => s.planned) },
              { label: "已跟踪设备", color: C_GRAY, values: items.map((s) => s.devices),
                readoutOnly: true },
            ]}
          />

          <TrendChart
            title="规划耗时"
            hint="扫描自身的开销（不含抽取）：预筛是两次批量往返，规划是对候选逐个读游标/查库。设备上万时这里是扫描实例的主要 CPU/IO 开销"
            times={times}
            format={(v) => `${v.toFixed(0)}ms`}
            series={[
              { label: "规划总计", color: C_LOAD, values: items.map((s) => s.plan_ms) },
              { label: "其中预筛", color: C_BLUE, values: items.map((s) => s.prefilter_ms) },
            ]}
          />
        </>
      )}
    </div>
  );
}

function KPI({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: "ok" | "warn" | "danger";
}) {
  return (
    <div className={`sweep-kpi ${tone ?? ""}`}>
      <div className="sweep-kpi-label">{label}</div>
      <div className="sweep-kpi-value">{value}</div>
      {sub && <div className="sweep-kpi-sub">{sub}</div>}
    </div>
  );
}
