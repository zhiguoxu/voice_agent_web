/**
 * 阈值控制面板（从 person_id/frontend/js/controls-panel.js 移植）。
 *
 * 按 group 分组渲染滑块，拖动实时显示、防抖 150ms 发送到服务端。
 * 写入落 DB 配置覆盖（持久化 + 多实例同步），需编辑口令——由 VisionView
 * 注入的 updateConfig 统一包口令（弹窗/缓存与「系统配置」页共用）。
 * 「恢复默认」回落到服务端初始下发的值（即 yaml/config 的启动值），
 * 前端不硬编码任何阈值，避免与服务端默认漂移。
 */
import { useEffect, useRef, useState } from "react";
import type { TunableParams } from "./types";

const GROUP_LABELS: Record<string, string> = {
  reid: "🔍 ReID",
  quality: "📊 Quality",
  matching: "🔗 Matching",
  stream: "📡 Stream",
};

const GROUP_COLORS: Record<string, string> = {
  reid: "group-reid",
  quality: "group-quality",
  matching: "group-matching",
  stream: "group-matching",
};

export function ControlsPanel({ params, updateConfig }: {
  /** 服务端下发的可调参数（连接成功后加载；null = 尚未加载） */
  params: TunableParams | null;
  /** 写参数（VisionView 注入，内部已包编辑口令弹窗/缓存） */
  updateConfig: (updates: Record<string, unknown>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, number>>({});
  // 服务端初始值快照，供「恢复默认」使用
  const defaultsRef = useRef<Record<string, number>>({});
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (!params) return;
    const vals = Object.fromEntries(
      Object.entries(params).map(([key, p]) => [key, p.value]),
    );
    defaultsRef.current = { ...vals };
    setValues(vals);
  }, [params]);

  useEffect(() => {
    const timers = debounceTimers.current;
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);

  const sendUpdate = (key: string, value: number) => {
    updateConfig({ [key]: value }).catch((e) => {
      console.error("[Config] Update failed:", e.message);
    });
  };

  const handleChange = (key: string, value: number) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    clearTimeout(debounceTimers.current[key]);
    debounceTimers.current[key] = setTimeout(() => sendUpdate(key, value), 150);
  };

  const resetToDefaults = () => {
    const defaults = defaultsRef.current;
    if (!Object.keys(defaults).length) return;
    setValues({ ...defaults });
    // 批量发送
    updateConfig(defaults).catch((e) => {
      console.error("[Config] Reset failed:", e.message);
    });
  };

  // 按 group 分组
  const groups: Record<string, Array<{ key: string } & NonNullable<TunableParams[string]>>> = {};
  if (params) {
    for (const [key, param] of Object.entries(params)) {
      const group = param.group || "other";
      (groups[group] ??= []).push({ key, ...param });
    }
  }

  return (
    <section className="side-panel controls-panel-root">
      <div className="panel-header">
        <h2>🎛️ Controls</h2>
        <div className="preset-buttons">
          <button className="btn btn-xs" onClick={resetToDefaults}>↺ 恢复默认</button>
        </div>
      </div>
      <div className="threshold-sliders">
        {Object.entries(groups).map(([group, items]) => (
          <div key={group} className="slider-group">
            <div className="slider-group-label">{GROUP_LABELS[group] || group}</div>
            {items.map((item) => {
              const value = values[item.key] ?? item.value;
              return (
                <div key={item.key} className="slider-item">
                  <span className="slider-label">{item.label}</span>
                  <input
                    type="range"
                    className={`slider-input ${GROUP_COLORS[group] || ""}`}
                    min={item.min}
                    max={item.max}
                    step={item.step}
                    value={value}
                    onChange={(e) => handleChange(item.key, parseFloat(e.target.value))}
                  />
                  <span className="slider-value">{value.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
