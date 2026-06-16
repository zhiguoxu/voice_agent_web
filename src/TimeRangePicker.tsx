import { useState, useRef, useEffect } from "react";

export interface TimeRange {
  start: string; // ISO datetime-local string or ""
  end: string;
}

interface Preset {
  label: string;
  getValue: () => TimeRange;
}

// Returns a UTC ISO string (e.g. "2026-05-23T01:30:00.000Z") that the
// server can parse unambiguously regardless of its own timezone setting.
function toLocalISO(date: Date): string {
  return date.toISOString();
}

function makePresets(): Preset[] {
  return [
    {
      label: "最近 15 分钟",
      getValue: () => ({
        start: toLocalISO(new Date(Date.now() - 15 * 60_000)),
        end: "",
      }),
    },
    {
      label: "最近 1 小时",
      getValue: () => ({
        start: toLocalISO(new Date(Date.now() - 60 * 60_000)),
        end: "",
      }),
    },
    {
      label: "最近 6 小时",
      getValue: () => ({
        start: toLocalISO(new Date(Date.now() - 6 * 60 * 60_000)),
        end: "",
      }),
    },
    {
      label: "最近 24 小时",
      getValue: () => ({
        start: toLocalISO(new Date(Date.now() - 24 * 60 * 60_000)),
        end: "",
      }),
    },
    {
      label: "今天",
      getValue: () => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return { start: toLocalISO(today), end: "" };
      },
    },
    {
      label: "昨天",
      getValue: () => {
        const now = new Date();
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return { start: toLocalISO(yesterday), end: toLocalISO(todayStart) };
      },
    },
    {
      label: "最近 7 天",
      getValue: () => ({
        start: toLocalISO(new Date(Date.now() - 7 * 24 * 60 * 60_000)),
        end: "",
      }),
    },
    {
      label: "最近 30 天",
      getValue: () => ({
        start: toLocalISO(new Date(Date.now() - 30 * 24 * 60 * 60_000)),
        end: "",
      }),
    },
  ];
}

function formatDisplay(start: string, end: string): string {
  if (!start && !end) return "全部时间";
  const fmt = (s: string) => {
    if (!s) return "现在";
    // 将 UTC ISO 字符串转成本地时间显示
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}:${ss}`;
  };
  return `${fmt(start)} ~ ${fmt(end)}`;
}

interface Props {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  disabled?: boolean;
}

export function TimeRangePicker({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [customStart, setCustomStart] = useState(value.start);
  const [customEnd, setCustomEnd] = useState(value.end);
  const ref = useRef<HTMLDivElement>(null);

  // Convert UTC ISO string to local datetime-local format for the input
  const toLocalDatetimeStr = (s: string): string => {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    // datetime-local needs "YYYY-MM-DDTHH:mm:ss" in local time
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // Sync custom inputs when value changes externally
  useEffect(() => {
    setCustomStart(toLocalDatetimeStr(value.start));
    setCustomEnd(toLocalDatetimeStr(value.end));
  }, [value.start, value.end]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const applyPreset = (preset: Preset) => {
    const range = preset.getValue();
    onChange(range);
    setOpen(false);
  };

  const applyCustom = () => {
    // datetime-local gives naive local strings like "2026-05-23T10:00:00"
    // Convert to UTC ISO for consistent server-side comparison
    const toUTC = (s: string) => s ? new Date(s).toISOString() : "";
    onChange({ start: toUTC(customStart), end: toUTC(customEnd) });
    setOpen(false);
  };

  const clearRange = () => {
    onChange({ start: "", end: "" });
    setOpen(false);
  };

  return (
    <div className="time-range-picker" ref={ref}>
      <button
        className="time-range-trigger"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
      >
        <span className="time-range-icon">🕐</span>
        <span className="time-range-display">
          {formatDisplay(value.start, value.end)}
        </span>
        <span className="time-range-arrow">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="time-range-dropdown">
          <div className="time-range-presets">
            <div className="time-range-section-title">快速选择</div>
            {makePresets().map((p) => (
              <button
                key={p.label}
                className="time-range-preset"
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </button>
            ))}
            <button className="time-range-preset clear" onClick={clearRange}>
              清除筛选
            </button>
          </div>
          <div className="time-range-custom">
            <div className="time-range-section-title">自定义范围</div>
            <label>
              开始
              <input
                type="datetime-local"
                step="1"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
            </label>
            <label>
              结束
              <input
                type="datetime-local"
                step="1"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </label>
            <button className="time-range-apply" onClick={applyCustom}>
              应用
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
