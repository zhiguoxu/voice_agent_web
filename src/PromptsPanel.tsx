import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchPrompts,
  fetchDeviceEditableConfig,
  fetchGroupEditableConfig,
  fetchConfigGroups,
  type PromptTemplateInfo,
  type EditableField,
  type DeviceEditableField,
  type ConfigGroup,
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
/** 定向覆盖的保存/恢复：第一个参数是作用域标识（device_sn 或分组名） */
type SaveScopedOverrideFn = (scopeId: string, path: string, value: unknown) => Promise<OverrideMutationResult>;
type RevertScopedOverrideFn = (scopeId: string, path: string) => Promise<OverrideMutationResult>;

/* 作用范围：全局 / 单台设备(device_sn) / 配置分组(握手头 Biz)。设备与分组两种定向
   覆盖走同一套三层值展示，只有文案与写入端点不同 */
type PromptScopeKind = "global" | "device" | "group";

const SCOPE_TEXT: Record<Exclude<PromptScopeKind, "global">, {
  badge: string; self: string; target: string; revert: string;
}> = {
  device: { badge: "设备覆盖", self: "该设备", target: "该设备", revert: "↺ 恢复全局值" },
  group: { badge: "分组覆盖", self: "该分组", target: "该分组的设备", revert: "↺ 恢复全局值" },
};

/** 一个模板在当前作用范围下的覆盖状态 */
interface PromptEditState {
  /** 当前作用范围内有覆盖：全局视角=数据库全局覆盖；设备/分组视角=该作用域的定向覆盖 */
  overridden: boolean;
  /** 定向视角下全局层另有覆盖（本作用域没有定向覆盖时生效的就是它）；全局视角恒为 false */
  globalOverridden: boolean;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 某个作用范围下加载到的模板列表与定向视角可编辑项，连同范围一起保存以便识别过期数据 */
interface ScopeView {
  /** 作用范围标识："" 全局 / "device:SN" / "group:NAME" */
  scopeKey: string;
  prompts: PromptTemplateInfo[];
  /** 设备/分组视角的可编辑项（path → 三层值）；全局视角为 null */
  scopedFields: Map<string, DeviceEditableField> | null;
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
    全局视角写全局覆盖，设备/分组视角写该作用域的定向覆盖。 */
function PromptItem({
  p,
  scope,
  editState,
  scopeLocked,
  onSave,
  onRevert,
}: {
  p: PromptTemplateInfo;
  /** 作用范围（模板正文已是该视角的生效值） */
  scope: PromptScopeKind;
  editState?: PromptEditState;
  /** 定向视角下此模板不支持按设备/分组覆盖（memory.texts.* 等只走全局） */
  scopeLocked?: boolean;
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
  const t = scope === "global" ? null : SCOPE_TEXT[scope];

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
          {overridden && (t ? (
            <span className="cfg-badge device-override" data-tip={`${t.self}有定向覆盖值，可在展开后「恢复全局值」回落到全局生效值`}>
              {t.badge}
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

        {scopeLocked && (
          <div className="cfg-prompt-editbar">
            <span className="cfg-edit-hint">此模板不支持按设备/分组覆盖（对所有设备统一生效），切回「全局」可编辑</span>
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
                data-tip={t
                  ? `删除${t.self}的定向覆盖，回落到全局生效值`
                  : "删除数据库里的覆盖值，恢复 yaml 原值"}
              >
                {reverting ? <span className="spinner inline" /> : t ? t.revert : "↺ 恢复默认"}
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
              {t ? `（当前生效的是${t.self}的定向覆盖值）` : "（当前生效的是数据库覆盖值）"}
            </span>
          )}
          {!overridden && editState?.globalOverridden && t && (
            <span className="cfg-prompt-override-note">（{t.self}无定向覆盖，当前生效的是全局数据库覆盖值）</span>
          )}
        </div>
      </div>
    </details>
  );
}

/** 提示词配置面板：汇总展示 agent_server 用到的全部 LLM 提示词模板，以及记忆服务
    (family_memory) 的抽取/日程模板（service="memory"，由 agent_server 一并返回）。
    yaml 来源且在对应服务可编辑白名单里的模板支持在线编辑（配置 DB 覆盖层）：
    agent 模板写 agent 的覆盖，memory 模板写记忆服务的覆盖（不支持按设备/分组覆盖）。
    作用范围可在「全局」、单台设备、配置分组间切换：选中设备后展示该设备视角的生效模板，
    保存即写该设备的定向覆盖；选中分组后展示握手头 Biz 为该分组名的设备视角，保存即写
    分组覆盖（设备覆盖 > 分组覆盖 > 全局覆盖 > yaml），范围外的设备不受影响。 */
export function PromptsPanel({
  editFields,
  onSaveOverride,
  onRevertOverride,
  memoryEditFields,
  onSaveMemoryOverride,
  onRevertMemoryOverride,
  onSaveDeviceOverride,
  onRevertDeviceOverride,
  onSaveGroupOverride,
  onRevertGroupOverride,
}: {
  /** agent_server 可编辑白名单（path → 字段状态）；未提供时全局视角纯只读 */
  editFields?: Map<string, EditableField>;
  onSaveOverride?: SaveOverrideFn;
  onRevertOverride?: RevertOverrideFn;
  /** 记忆服务可编辑白名单与保存/恢复；未提供时记忆模板纯只读 */
  memoryEditFields?: Map<string, EditableField>;
  onSaveMemoryOverride?: SaveOverrideFn;
  onRevertMemoryOverride?: RevertOverrideFn;
  /** 设备级保存/恢复（第一个参数 device_sn）；未提供时设备视角纯只读 */
  onSaveDeviceOverride?: SaveScopedOverrideFn;
  onRevertDeviceOverride?: RevertScopedOverrideFn;
  /** 分组级保存/恢复（第一个参数分组名）；未提供时分组视角纯只读 */
  onSaveGroupOverride?: SaveScopedOverrideFn;
  onRevertGroupOverride?: RevertScopedOverrideFn;
}) {
  const [view, setView] = useState<ScopeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /* 作用范围：两者都空=全局；deviceSn 非空=设备视角；groupName 非空=分组视角（互斥） */
  const [deviceSn, setDeviceSn] = useState("");
  const [groupName, setGroupName] = useState("");
  const [candidates, setCandidates] = useState<DeviceCandidate[]>([]);
  /* 各设备在 agent_server 的覆盖条数（选择器角标） */
  const [overrideCounts, setOverrideCounts] = useState<Map<string, number>>(new Map());
  /* 配置分组（档案 + agent_server 的覆盖条数），分组选择器候选 */
  const [groups, setGroups] = useState<ConfigGroup[]>([]);
  /* 连续切换作用范围时丢弃过期响应，避免旧范围的结果覆盖新范围 */
  const loadSeq = useRef(0);

  const scope: PromptScopeKind = deviceSn ? "device" : groupName ? "group" : "global";
  const scopeKey = deviceSn ? `device:${deviceSn}` : groupName ? `group:${groupName}` : "";

  const loadCandidates = useCallback(async () => {
    const [next, groupList] = await Promise.all([
      loadDeviceCandidates(["agent"]),
      fetchConfigGroups("agent").catch(() => null),
    ]);
    setCandidates(next.candidates);
    setOverrideCounts(new Map([...next.summary.values()].map((d) => [d.device_sn, d.override_count])));
    if (groupList) setGroups(groupList.groups);
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const [prompts, scopedCfg] = await Promise.all([
        fetchPrompts(deviceSn, groupName),
        deviceSn
          ? fetchDeviceEditableConfig("agent", deviceSn)
          : groupName ? fetchGroupEditableConfig("agent", groupName) : null,
      ]);
      if (seq !== loadSeq.current) return;
      setView({
        scopeKey,
        prompts,
        scopedFields: scopedCfg ? new Map(scopedCfg.items.map((f) => [f.path, f])) : null,
      });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [deviceSn, groupName, scopeKey]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadCandidates();
  }, [loadCandidates]);

  /* 只渲染与当前作用范围一致的结果：切换范围后旧范围的模板不会被短暂当成新范围的展示 */
  const current = view?.scopeKey === scopeKey ? view : null;
  const prompts = current?.prompts ?? null;
  /* 有 config_path 却不在定向可编辑项里的模板不支持按设备/分组覆盖 */
  const scopedFields = current?.scopedFields ?? null;
  const deviceName = candidates.find((d) => d.sn === deviceSn)?.name ?? "";

  /* 定向作用域（设备/分组）的保存/恢复：写入端点不同，其余流程一致 */
  const scopedSave = scope === "device" ? onSaveDeviceOverride : scope === "group" ? onSaveGroupOverride : undefined;
  const scopedRevert = scope === "device" ? onRevertDeviceOverride : scope === "group" ? onRevertGroupOverride : undefined;
  const scopeId = deviceSn || groupName;

  return (
    <div className="card cfg-card cfg-prompt-card">
      <h3>
        📝 提示词配置
        <span className="subtitle">
          当前生效的全部 LLM 提示词模板（对话 / 动作表情 / 记忆 / 日程），YAML 来源的可在线编辑；可切到单台设备或配置分组做定向覆盖
        </span>
        {prompts && <span className="cfg-badges"><span className="cfg-badge">{prompts.length} 个模板</span></span>}
        <button className="roster-refresh" onClick={load} disabled={loading}>
          {loading ? <span className="spinner inline" /> : "🔄 刷新"}
        </button>
      </h3>

      <div className="cfg-device-toolbar">
        <label>
          设备：
          <DevicePicker
            value={deviceSn}
            onChange={(sn) => { setDeviceSn(sn); if (sn) setGroupName(""); }}
            candidates={candidates}
            badgeFor={(sn) => {
              const n = overrideCounts.get(sn) ?? 0;
              return n > 0 ? `${n} 条覆盖` : null;
            }}
            placeholder="全局（点击选择设备，切换为只对该设备生效的定向编辑）"
          />
        </label>
        <label>
          分组：
          <select
            className="cfg-group-select"
            value={groupName}
            onChange={(e) => { setGroupName(e.target.value); if (e.target.value) setDeviceSn(""); }}
            data-tip={groups.length === 0 ? "还没有配置分组，先在「配置分组」面板创建" : "切换为只对该分组（握手头 Biz 相同）的设备生效的定向编辑"}
          >
            <option value="">全局</option>
            {groups.map((g) => (
              <option value={g.name} key={g.name}>
                {g.name}{g.override_count > 0 ? ` · ${g.override_count} 条覆盖` : ""}
              </option>
            ))}
          </select>
        </label>
        {scope === "device" && (
          <span className="cfg-device-summary">
            正在查看设备 {deviceLabel(deviceSn, deviceName)} 的生效模板：保存即该设备的定向覆盖，只对它生效（设备覆盖 &gt; 分组覆盖 &gt; 全局覆盖 &gt; yaml）
          </span>
        )}
        {scope === "group" && (
          <span className="cfg-device-summary">
            正在查看分组 {groupName} 的生效模板：保存即该分组的覆盖，对握手头 Biz={groupName} 的设备生效（设备覆盖 &gt; 分组覆盖 &gt; 全局覆盖 &gt; yaml）
          </span>
        )}
        {scope === "global" && (
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
            const isMemory = p.service === "memory";
            let editState: PromptEditState | undefined;
            let scopeLocked = false;
            let onSave: ((value: string) => Promise<void>) | undefined;
            let onRevert: (() => Promise<void>) | undefined;
            if (isMemory) {
              /* 记忆服务的模板: 全局编辑走记忆服务的覆盖层; 定向视角只读(不支持按设备/分组覆盖) */
              const f = path ? memoryEditFields?.get(path) : undefined;
              scopeLocked = scope !== "global" && path != null;
              if (path && f && scope === "global") {
                editState = { overridden: f.overridden, globalOverridden: false };
                if (onSaveMemoryOverride) {
                  onSave = async (v) => { await onSaveMemoryOverride(path, v); await load(); };
                }
                if (onRevertMemoryOverride) {
                  onRevert = async () => { await onRevertMemoryOverride(path); await load(); };
                }
              }
            } else if (scope !== "global") {
              const f = path ? scopedFields?.get(path) : undefined;
              scopeLocked = path != null && scopedFields != null && f == null;
              if (path && f) {
                editState = {
                  overridden: f.overridden,
                  globalOverridden: !sameValue(f.global_value, f.baseline),
                };
                const id = scopeId;
                if (scopedSave) {
                  onSave = async (v) => {
                    await scopedSave(id, path, v);
                    await Promise.all([load(), loadCandidates()]);
                  };
                }
                if (scopedRevert) {
                  onRevert = async () => {
                    await scopedRevert(id, path);
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
                key={`${scopeKey}:${p.key}`}
                scope={scope}
                editState={editState}
                scopeLocked={scopeLocked}
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
