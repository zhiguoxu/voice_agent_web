import { useState, useEffect, useRef } from "react";
import { searchDevices } from "./api";
import { deviceLabel, type DeviceCandidate } from "./deviceCandidates";
import "./ConfigView.css";

/* ── 设备选择器 ──
   「系统配置」页里所有按设备定向操作的入口共用（设备级配置覆盖 / 提示词配置）：
   可搜索组合框，不输入时列出候选，输入即按名称/SN 模糊搜索。
   候选集由调用方通过 deviceCandidates.ts 的 loadDeviceCandidates 准备。 */

export function DevicePicker({
  value,
  onChange,
  candidates,
  badgeFor,
  placeholder = "点击选择设备（可输入名称/SN 搜索）",
}: {
  /** 选中的 device_sn，空串=未选 */
  value: string;
  onChange: (sn: string) => void;
  candidates: DeviceCandidate[];
  /** 候选行右侧角标文案（如「N 条覆盖」），返回空即不显示 */
  badgeFor?: (sn: string) => string | null;
  /** 未选中且未展开时的占位提示 */
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DeviceCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [comboOpen, setComboOpen] = useState(false);
  const comboRef = useRef<HTMLSpanElement>(null);
  /* 通过搜索选中、不在候选集里的设备：记住显示名，关掉下拉后仍能显示「名称 (SN)」 */
  const [pickedName, setPickedName] = useState<Map<string, string>>(new Map());

  /* 防抖搜索：后端按名称/SN 模糊匹配（覆盖全部设备档案与历史会话设备），
     本地候选同步过滤兜底（后端不可达时至少能搜下拉里已有的） */
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const lower = q.toLowerCase();
      const merged = new Map<string, string>();
      for (const d of candidates) {
        if (d.sn.toLowerCase().includes(lower) || d.name.toLowerCase().includes(lower)) {
          merged.set(d.sn, d.name);
        }
      }
      try {
        for (const d of await searchDevices(q)) {
          merged.set(d.device_sn, d.name || merged.get(d.device_sn) || "");
        }
      } catch {
        /* 后端搜索失败时静默降级为本地候选过滤 */
      }
      setSearchResults([...merged.entries()].map(([sn, name]) => ({ sn, name })));
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, candidates]);

  /* 点组合框外部关闭下拉 */
  useEffect(() => {
    if (!comboOpen) return;
    const onDown = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setComboOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [comboOpen]);

  const pick = (d: DeviceCandidate) => {
    setPickedName((m) => new Map(m).set(d.sn, d.name));
    onChange(d.sn);
    setQuery("");
    setComboOpen(false);
  };

  /* 组合框列表：不输入时列全部候选，输入后换成搜索结果 */
  const comboOptions = query.trim() ? (searchResults ?? []) : candidates;
  const selectedName =
    candidates.find((d) => d.sn === value)?.name || pickedName.get(value) || "";

  return (
    <span className="cfg-device-combo" ref={comboRef}>
      <input
        type="text"
        value={comboOpen ? query : value ? deviceLabel(value, selectedName) : ""}
        onFocus={() => { setQuery(""); setComboOpen(true); }}
        onChange={(e) => { setQuery(e.target.value); setComboOpen(true); }}
        onKeyDown={(e) => e.key === "Escape" && setComboOpen(false)}
        placeholder={comboOpen ? "输入设备名称或 SN 模糊搜索，或从列表点选" : placeholder}
      />
      {value && !comboOpen && (
        <button
          className="cfg-device-combo-clear"
          data-tip="清除选择"
          onClick={() => { onChange(""); setQuery(""); }}
        >×</button>
      )}
      {comboOpen && (
        <div className="cfg-device-combo-list">
          {searching && <div className="cfg-device-combo-empty"><span className="spinner inline" /> 搜索中…</div>}
          {!searching && comboOptions.length === 0 && (
            <div className="cfg-device-combo-empty">
              {query.trim() ? `没有匹配「${query.trim()}」的设备（名称与 SN 均未命中）` : "暂无候选设备，输入名称或 SN 搜索"}
            </div>
          )}
          {!searching && comboOptions.map((d) => {
            const badge = badgeFor?.(d.sn);
            return (
              <button
                className={`cfg-device-combo-option ${d.sn === value ? "active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(d)}
                key={d.sn}
              >
                <span className="cfg-device-combo-name">{d.name || d.sn}</span>
                {d.name && <span className="cfg-device-combo-sn">{d.sn}</span>}
                {badge && <span className="cfg-device-combo-count">{badge}</span>}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
