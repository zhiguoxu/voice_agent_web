import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchPrompts,
  fetchDeviceEditableConfig,
  type PromptTemplateInfo,
  type EditableField,
  type DeviceEditableField,
  type OverrideMutationResult,
} from "./api";
import { DevicePicker } from "./DevicePicker";
import { deviceLabel, loadDeviceCandidates, type DeviceCandidate } from "./deviceCandidates";
import "./ConfigView.css";

/* source_kind → 徽标文案：帮助非开发同学分清「改配置就能调」和「要改代码发版」 */
const SOURCE_KIND_LABELS: Record<string, string> = {
  yaml: "YAML 配置",
  code: "代码内置",
};

type SaveOverrideFn = (path: string, value: unknown) => Promise<OverrideMutationResult>;
type RevertOverrideFn = (path: string) => Promise<OverrideMutationResult>;
type SaveDeviceOverrideFn = (deviceSn: string, path: string, value: unknown) => Promise<OverrideMutationResult>;
type RevertDeviceOverrideFn = (deviceSn: string, path: string) => Promise<OverrideMutationResult>;

/** 一个模板在当前作用范围下的覆盖状态 */
interface PromptEditState {
  /** 当前作用范围内有覆盖：全局视角=数据库全局覆盖；设备视角=该设备的定向覆盖 */
  overridden: boolean;
  /** 设备视角下全局层另有覆盖（设备没有定向覆盖时生效的就是它）；全局视角恒为 false */
  globalOverridden: boolean;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 某个作用范围下加载到的模板列表与设备视角可编辑项，连同范围一起保存以便识别过期数据 */
interface ScopeView {
  deviceSn: string;
  prompts: PromptTemplateInfo[];
  /** 设备视角的可编辑项（path → 三层值）；全局视角为 null */
  deviceFields: Map<string, DeviceEditableField> | null;
}

/** 模板正文渲染：把程序占位符高亮成色块，其余文本原样输出 */
function TemplateText({ text, placeholders }: { text: string; placeholders: string[] }) {
  if (placeholders.length === 0) {
    return <pre className="cfg-prompt-pre">{text}</pre>;
  }
  const escaped = placeholders.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "g");
  return (
    <pre className="cfg-prompt-pre">
      {text.split(re).map((part, i) =>
        placeholders.includes(part)
          ? <mark className="cfg-ph" key={i}>{part}</mark>
          : part
      )}
    </pre>
  );
}

/** 提示词模板编辑器：textarea + 保存/取消，校验失败原样展示后端报错 */
function PromptEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (e: any) {
      setError(e.message || String(e));
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div className="cfg-edit-box prompt">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(24, Math.max(8, draft.split("\n").length + 2))}
        disabled={saving}
      />
      {error && <div className="cfg-error">❌ {error}</div>}
      <div className="cfg-edit-actions">
        <button className="cfg-edit-save" onClick={save} disabled={saving}>
          {saving ? <span className="spinner inline" /> : "保存"}
        </button>
        <button className="cfg-edit-cancel" onClick={onCancel} disabled={saving}>取消</button>
      </div>
    </div>
  );
}

/** 单个提示词模板：折叠条目，展开后是说明 + 占位符表 + 正文（模板/渲染后可切换）。
    带 config_path 且命中可编辑字段表的模板可在线编辑，编辑后的值存数据库：
    全局视角写全局覆盖，设备视角写该设备的定向覆盖。 */
function PromptItem({
  p,
  deviceSn,
  editState,
  deviceLocked,
  onSave,
  onRevert,
}: {
  p: PromptTemplateInfo;
  /** 作用范围：空串=全局，否则=设备 SN（模板正文已是该设备视角的生效值） */
  deviceSn: string;
  editState?: PromptEditState;
  /** 设备视角下此模板不支持按设备覆盖（memory.texts.* 等只走全局） */
  deviceLocked?: boolean;
  onSave?: (value: string) => Promise<void>;
  onRevert?: () => Promise<void>;
}) {
  const [view, setView] = useState<"template" | "rendered">("template");
  const [editing, setEditing] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const showRendered = view === "rendered" && p.rendered != null;
  const text = showRendered ? p.rendered! : p.template;
  const editable = editState != null && onSave != null;
  const overridden = editState?.overridden ?? false;

  const revert = async () => {
    if (!onRevert || reverting) return;
    setReverting(true);
    setRevertError(null);
    try {
      await onRevert();
    } catch (e: any) {
      setRevertError(e.message || String(e));
    }
    setReverting(false);
  };

  return (
    <details className="cfg-prompt-item">
      <summary>
        <span className="cfg-prompt-title">{p.title}</span>
        <code className="cfg-section-key">{p.key}</code>
        <span className="cfg-prompt-summary-badges">
          <span className={`cfg-badge kind-${p.source_kind}`}>
            {SOURCE_KIND_LABELS[p.source_kind] || p.source_kind}
          </span>
          {editState?.globalOverridden && (
            <span className="cfg-badge modified" data-tip="全局层已被在线编辑覆盖，对所有没有定向覆盖的设备生效">
              全局已修改
            </span>
          )}
          {overridden && (deviceSn ? (
            <span className="cfg-badge device-override" data-tip="该设备有定向覆盖值，可在展开后「恢复全局值」回落到全局生效值">
              设备覆盖
            </span>
          ) : (
            <span className="cfg-badge modified" data-tip="已被在线编辑覆盖，可在展开后「恢复默认」回到 yaml 原值">
              已修改
            </span>
          ))}
          {p.model && <span className="cfg-badge model">{p.model}</span>}
          <span className="cfg-prompt-len">{p.template.length} 字符</span>
        </span>
      </summary>

      <div className="cfg-prompt-body">
        <p className="cfg-prompt-usage">{p.usage}</p>

        {p.placeholders.length > 0 && (
          <div className="cfg-prompt-placeholders">
            {p.placeholders.map((ph) => (
              <div className="cfg-prompt-placeholder" key={ph.name}>
                <mark className="cfg-ph">{ph.name}</mark>
                <span>{ph.note}</span>
              </div>
            ))}
          </div>
        )}

        {deviceLocked && (
          <div className="cfg-prompt-editbar">
            <span className="cfg-edit-hint">此模板不支持按设备覆盖（对所有设备统一生效），切回「全局」可编辑</span>
          </div>
        )}

        {editable && !editing && (
          <div className="cfg-prompt-editbar">
            <button className="cfg-edit-save" onClick={() => setEditing(true)}>
              ✏️ 编辑模板
            </button>
            {overridden && (
              <button
                className="cfg-edit-cancel"
                onClick={revert}
                disabled={reverting}
                data-tip={deviceSn
                  ? "删除该设备的定向覆盖，回落到全局生效值"
                  : "删除数据库里的覆盖值，恢复 yaml 原值"}
              >
                {reverting ? <span className="spinner inline" /> : deviceSn ? "↺ 恢复全局值" : "↺ 恢复默认"}
              </button>
            )}
            {revertError && <span className="cfg-error inline">❌ {revertError}</span>}
          </div>
        )}

        {editing && onSave ? (
          <PromptEditor
            initial={p.template}
            onSave={async (v) => {
              await onSave(v);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            {p.rendered != null && (
              <div className="cfg-prompt-viewtabs">
                <button
                  className={view === "template" ? "active" : ""}
                  onClick={() => setView("template")}
                >
                  模板原文
                </button>
                <button
                  className={view === "rendered" ? "active" : ""}
                  onClick={() => setView("rendered")}
                >
                  渲染后（实际下发）
                </button>
              </div>
            )}

            <TemplateText
              text={text}
              placeholders={showRendered ? [] : p.placeholders.map((ph) => ph.name)}
            />
          </>
        )}

        <div className="cfg-prompt-source">
          来源: <code>{p.source}</code>
          {overridden && (
            <span className="cfg-prompt-override-note">
              {deviceSn ? "（当前生效的是该设备的定向覆盖值）" : "（当前生效的是数据库覆盖值）"}
            </span>
          )}
          {!overridden && editState?.globalOverridden && (
            <span className="cfg-prompt-override-note">（该设备无定向覆盖，当前生效的是全局数据库覆盖值）</span>
          )}
        </div>
      </div>
    </details>
  );
}

/** 提示词配置面板：汇总展示 agent_server 用到的全部 LLM 提示词模板。
    yaml 来源且在可编辑白名单里的模板支持在线编辑（配置 DB 覆盖层）。
    作用范围可在「全局」与单台设备间切换：选中设备后展示该设备视角的生效模板，
    保存即写该设备的定向覆盖（设备覆盖 > 全局覆盖 > yaml），其他设备不受影响。 */
export function PromptsPanel({
  editFields,
  onSaveOverride,
  onRevertOverride,
  onSaveDeviceOverride,
  onRevertDeviceOverride,
}: {
  /** agent_server 可编辑白名单（path → 字段状态）；未提供时全局视角纯只读 */
  editFields?: Map<string, EditableField>;
  onSaveOverride?: SaveOverrideFn;
  onRevertOverride?: RevertOverrideFn;
  /** 设备级保存/恢复；未提供时设备视角纯只读 */
  onSaveDeviceOverride?: SaveDeviceOverrideFn;
  onRevertDeviceOverride?: RevertDeviceOverrideFn;
}) {
  const [view, setView] = useState<ScopeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /* 作用范围：空串=全局；否则查看/编辑该设备视角的生效模板 */
  const [deviceSn, setDeviceSn] = useState("");
  const [candidates, setCandidates] = useState<DeviceCandidate[]>([]);
  /* 各设备在 agent_server 的覆盖条数（选择器角标） */
  const [overrideCounts, setOverrideCounts] = useState<Map<string, number>>(new Map());
  /* 连续切换作用范围时丢弃过期响应，避免旧范围的结果覆盖新范围 */
  const loadSeq = useRef(0);

  const loadCandidates = useCallback(async () => {
    const next = await loadDeviceCandidates(["agent"]);
    setCandidates(next.candidates);
    setOverrideCounts(new Map([...next.summary.values()].map((d) => [d.device_sn, d.override_count])));
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const [prompts, deviceCfg] = await Promise.all([
        fetchPrompts(deviceSn),
        deviceSn ? fetchDeviceEditableConfig("agent", deviceSn) : null,
      ]);
      if (seq !== loadSeq.current) return;
      setView({
        deviceSn,
        prompts,
        deviceFields: deviceCfg ? new Map(deviceCfg.items.map((f) => [f.path, f])) : null,
      });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [deviceSn]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadCandidates();
  }, [loadCandidates]);

  /* 只渲染与当前作用范围一致的结果：切换范围后旧范围的模板不会被短暂当成新范围的展示 */
  const current = view?.deviceSn === deviceSn ? view : null;
  const prompts = current?.prompts ?? null;
  /* 有 config_path 却不在设备可编辑项里的模板不支持按设备覆盖 */
  const deviceFields = current?.deviceFields ?? null;
  const deviceName = candidates.find((d) => d.sn === deviceSn)?.name ?? "";

  return (
    <div className="card cfg-card cfg-prompt-card">
      <h3>
        📝 提示词配置
        <span className="subtitle">
          当前生效的全部 LLM 提示词模板（对话 / 动作表情 / 记忆 / 日程），YAML 来源的可在线编辑；可切到单台设备做定向覆盖
        </span>
        {prompts && <span className="cfg-badges"><span className="cfg-badge">{prompts.length} 个模板</span></span>}
        <button className="roster-refresh" onClick={load} disabled={loading}>
          {loading ? <span className="spinner inline" /> : "🔄 刷新"}
        </button>
      </h3>

      <div className="cfg-device-toolbar">
        <label>
          作用范围：
          <DevicePicker
            value={deviceSn}
            onChange={setDeviceSn}
            candidates={candidates}
            badgeFor={(sn) => {
              const n = overrideCounts.get(sn) ?? 0;
              return n > 0 ? `${n} 条覆盖` : null;
            }}
            placeholder="全局（点击选择设备，切换为只对该设备生效的定向编辑）"
          />
        </label>
        {deviceSn ? (
          <span className="cfg-device-summary">
            正在查看设备 {deviceLabel(deviceSn, deviceName)} 的生效模板：保存即该设备的定向覆盖，只对它生效（设备覆盖 &gt; 全局覆盖 &gt; yaml）
          </span>
        ) : (
          <span className="cfg-device-summary muted">全局：保存后对所有没有定向覆盖的设备生效</span>
        )}
      </div>

      {error && <div className="cfg-error">❌ 加载失败: {error}</div>}
      {loading && !prompts && !error && (
        <div className="empty"><div className="spinner" /></div>
      )}

      {prompts && (
        <div className="cfg-prompt-list">
          {prompts.map((p) => {
            const path = p.config_path;
            let editState: PromptEditState | undefined;
            let deviceLocked = false;
            let onSave: ((value: string) => Promise<void>) | undefined;
            let onRevert: (() => Promise<void>) | undefined;
            if (deviceSn) {
              const f = path ? deviceFields?.get(path) : undefined;
              deviceLocked = path != null && deviceFields != null && f == null;
              if (path && f) {
                editState = {
                  overridden: f.overridden,
                  globalOverridden: !sameValue(f.global_value, f.baseline),
                };
                const sn = deviceSn;
                if (onSaveDeviceOverride) {
                  onSave = async (v) => {
                    await onSaveDeviceOverride(sn, path, v);
                    await Promise.all([load(), loadCandidates()]);
                  };
                }
                if (onRevertDeviceOverride) {
                  onRevert = async () => {
                    await onRevertDeviceOverride(sn, path);
                    await Promise.all([load(), loadCandidates()]);
                  };
                }
              }
            } else {
              const f = path ? editFields?.get(path) : undefined;
              if (path && f) {
                editState = { overridden: f.overridden, globalOverridden: false };
                if (onSaveOverride) {
                  onSave = async (v) => { await onSaveOverride(path, v); await load(); };
                }
                if (onRevertOverride) {
                  onRevert = async () => { await onRevertOverride(path); await load(); };
                }
              }
            }
            return (
              <PromptItem
                p={p}
                key={`${deviceSn}:${p.key}`}
                deviceSn={deviceSn}
                editState={editState}
                deviceLocked={deviceLocked}
                onSave={onSave}
                onRevert={onRevert}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
