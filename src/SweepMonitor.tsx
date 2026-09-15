/**
 * 监控面板共用的手搓 SVG 图件：TrendChart（折线趋势）与 KPI（指标卡）。
 *
 * 由流量监控(TrafficMonitor)与拉流并发(StreamConcurrency)面板复用；文件名沿用
 * 首个使用它们的面板。
 */
import { useMemo, useRef, useState } from "react";
import "./SweepMonitor.css";

const C_DANGER = "#f87171";

/* ────────────────────────── 通用折线图 ────────────────────────── */

const W = 600;
const H = 140;

export interface Series {
  label: string;
  color: string;
  /** 与 times 等长；null = 该轮无此值（如超载轮没有排空耗时），断线不连 */
  values: (number | null)[];
  /** 只在图例里出数值、不画线：用于与主线成常数倍的派生量（画出来是条贴底的直线） */
  readoutOnly?: boolean;
  /** 该读数自己的格式化（单位与主轴不同时用） */
  format?: (v: number) => string;
}

export interface RefLine {
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
export function TrendChart({ title, hint, times, series, refLines, format, marks }: {
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

export function KPI({ label, value, sub, tone }: {
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
