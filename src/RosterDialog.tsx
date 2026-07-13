import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchRoster, deleteRosterMember, updateRosterMember,
  addRosterRelation, deleteRosterRelation,
  type RosterData, type RosterMember, type RosterRelation,
} from "./api";
import "./RosterDialog.css";

/* 角色/性别的展示映射：兜底显示原始值，方便发现抽取出的脏数据 */
const ROLE_LABELS: Record<string, string> = {
  father: "爸爸",
  mother: "妈妈",
  son: "儿子",
  daughter: "女儿",
  child: "孩子",
  grandfather: "爷爷/外公",
  grandmother: "奶奶/外婆",
  grandson: "孙子",
  granddaughter: "孙女",
  husband: "丈夫",
  wife: "妻子",
};

const GENDER_LABELS: Record<string, string> = {
  male: "男",
  female: "女",
};

function formatTime(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN");
}

/** 成员行的编辑态草稿（全部用字符串承载，保存时归一） */
interface MemberDraft {
  name: string;
  aliases: string;      // "/" 或 "," 分隔
  role: string;
  gender: string;
  birth_year: string;
}

function toDraft(m: RosterMember): MemberDraft {
  return {
    name: m.name ?? "",
    aliases: m.aliases.join(" / "),
    role: m.role ?? "",
    gender: m.gender ?? "",
    birth_year: m.birth_year != null ? String(m.birth_year) : "",
  };
}

/**
 * 家庭花名册对话框：按会话设备所属家庭展示与编辑（多家庭同库，不做全库 dump）。
 * 从会话标题行的「👨‍👩‍👧‍👦 花名册」按钮打开。
 */
export function RosterDialog({ deviceSn, onClose }: { deviceSn: string; onClose: () => void }) {
  const [roster, setRoster] = useState<RosterData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* 两步确认删除：第一次点进入待确认态（3 秒内再点才执行），避免误触 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  /* 行内编辑：同一时刻只编辑一行 */
  const [editingPid, setEditingPid] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemberDraft | null>(null);
  const [saving, setSaving] = useState(false);
  /* 添加关系边表单 */
  const [relSubject, setRelSubject] = useState("");
  const [relKind, setRelKind] = useState("parent_of");
  const [relObject, setRelObject] = useState("");
  const [relBusy, setRelBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoster(await fetchRoster(deviceSn));
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [deviceSn]);

  useEffect(() => {
    load();
  }, [load]);

  /* Esc 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const armDelete = (personId: string) => {
    setPendingDelete(personId);
    if (pendingTimerRef.current) window.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = window.setTimeout(() => setPendingDelete(null), 3000);
  };

  const confirmDelete = async (personId: string) => {
    if (pendingTimerRef.current) window.clearTimeout(pendingTimerRef.current);
    setPendingDelete(null);
    setDeleting(personId);
    try {
      await deleteRosterMember(personId, deviceSn);
      await load();
    } catch (e: any) {
      setError(`删除失败: ${e.message || String(e)}`);
    } finally {
      setDeleting(null);
    }
  };

  const startEdit = (m: RosterMember) => {
    setEditingPid(m.person_id);
    setDraft(toDraft(m));
  };

  const cancelEdit = () => {
    setEditingPid(null);
    setDraft(null);
  };

  const saveEdit = async () => {
    if (!editingPid || !draft) return;
    const year = draft.birth_year.trim();
    if (year && !/^\d{4}$/.test(year)) {
      setError("出生年须为 4 位数字");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateRosterMember(editingPid, deviceSn, {
        name: draft.name.trim() || null,
        aliases: draft.aliases.split(/[/,，、]/).map((s) => s.trim()).filter(Boolean),
        role: draft.role.trim() || null,
        gender: draft.gender || null,
        birth_year: year ? Number(year) : null,
      });
      cancelEdit();
      await load();
    } catch (e: any) {
      setError(`保存失败: ${e.message || String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const addRelation = async () => {
    if (!relSubject || !relObject || relSubject === relObject) return;
    setRelBusy(true);
    setError(null);
    try {
      await addRosterRelation(deviceSn, relSubject, relKind, relObject);
      setRelSubject("");
      setRelObject("");
      await load();
    } catch (e: any) {
      setError(`添加关系失败: ${e.message || String(e)}`);
    } finally {
      setRelBusy(false);
    }
  };

  const removeRelation = async (r: RosterRelation) => {
    setRelBusy(true);
    setError(null);
    try {
      await deleteRosterRelation(deviceSn, r.subject_id, r.relation, r.object_id);
      await load();
    } catch (e: any) {
      setError(`删除关系失败: ${e.message || String(e)}`);
    } finally {
      setRelBusy(false);
    }
  };

  /** 该成员参与的关系边数（删除时连带清理，确认按钮上提示） */
  const relationCount = (personId: string) =>
    roster?.relations.filter((r) => r.subject_id === personId || r.object_id === personId).length ?? 0;

  /* person_id → 展示名（名字 > 小名 > id 截断），关系边渲染用 */
  const displayName = (pid: string): string => {
    const m = roster?.members.find((x) => x.person_id === pid);
    if (!m) return pid;
    return m.name || m.aliases[0] || pid;
  };

  /* 关系边转人话：parent_of 有向，spouse_of 语义无向 */
  const relationText = (subjectId: string, relation: string, objectId: string): string => {
    const s = displayName(subjectId);
    const o = displayName(objectId);
    if (relation === "parent_of") {
      const gender = roster?.members.find((x) => x.person_id === subjectId)?.gender;
      const roleWord = gender === "male" ? "父亲" : gender === "female" ? "母亲" : "父/母";
      return `${s} 是 ${o} 的${roleWord}`;
    }
    if (relation === "spouse_of") return `${s} 与 ${o} 是配偶`;
    return `${s} —${relation}→ ${o}`;
  };

  const renderEditRow = (m: RosterMember) => (
    <tr key={m.person_id} className="roster-edit-row">
      <td><code className="roster-pid" title={m.person_id}>{m.person_id}</code></td>
      <td>
        <input className="roster-input" value={draft!.name} placeholder="名字"
               onChange={(e) => setDraft({ ...draft!, name: e.target.value })} />
      </td>
      <td>
        <input className="roster-input" value={draft!.aliases} placeholder="别名，/ 分隔"
               onChange={(e) => setDraft({ ...draft!, aliases: e.target.value })} />
      </td>
      <td>
        <select className="roster-input" value={draft!.role}
                onChange={(e) => setDraft({ ...draft!, role: e.target.value })}>
          <option value="">-</option>
          {Object.entries(ROLE_LABELS).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
          {draft!.role && !(draft!.role in ROLE_LABELS) && (
            <option value={draft!.role}>{draft!.role}</option>
          )}
        </select>
      </td>
      <td>
        <select className="roster-input" value={draft!.gender}
                onChange={(e) => setDraft({ ...draft!, gender: e.target.value })}>
          <option value="">-</option>
          <option value="male">男</option>
          <option value="female">女</option>
        </select>
      </td>
      <td>
        <input className="roster-input year" value={draft!.birth_year} placeholder="如 2016"
               onChange={(e) => setDraft({ ...draft!, birth_year: e.target.value })} />
      </td>
      <td className="roster-time">{formatTime(m.created_at)}</td>
      <td className="roster-time">{formatTime(m.updated_at)}</td>
      <td className="roster-edit-actions">
        <button className="roster-save-btn" onClick={saveEdit} disabled={saving}>
          {saving ? <span className="spinner inline" /> : "保存"}
        </button>
        <button className="roster-cancel-btn" onClick={cancelEdit} disabled={saving}>取消</button>
      </td>
    </tr>
  );

  const renderMemberRow = (m: RosterMember) => {
    if (editingPid === m.person_id && draft) return renderEditRow(m);
    return (
      <tr key={m.person_id}>
        <td><code className="roster-pid" title={m.person_id}>{m.person_id}</code></td>
        <td className="roster-name">{m.name || <span className="roster-missing">未记名</span>}</td>
        <td>{m.aliases.length > 0 ? m.aliases.join(" / ") : "-"}</td>
        <td>
          {m.role ? (
            <span className="roster-role" title={m.role}>
              {ROLE_LABELS[m.role] || m.role}
            </span>
          ) : "-"}
        </td>
        <td>{m.gender ? (GENDER_LABELS[m.gender] || m.gender) : "-"}</td>
        <td>{m.birth_year ?? "-"}</td>
        <td className="roster-time">{formatTime(m.created_at)}</td>
        <td className="roster-time">{formatTime(m.updated_at)}</td>
        <td className="roster-edit-actions">
          <button
            className="roster-edit-btn"
            onClick={() => startEdit(m)}
            disabled={editingPid !== null}
            title="编辑成员属性"
          >
            ✏️
          </button>
          {pendingDelete === m.person_id ? (
            <button
              className="roster-delete-btn confirm"
              onClick={() => confirmDelete(m.person_id)}
              title="再次点击确认；连带删除该成员参与的全部关系边"
            >
              确认删除{relationCount(m.person_id) > 0 ? `(含${relationCount(m.person_id)}条关系)` : ""}
            </button>
          ) : (
            <button
              className="roster-delete-btn"
              onClick={() => armDelete(m.person_id)}
              disabled={deleting === m.person_id || editingPid !== null}
              title="删除该成员（会先清理其全部关系边）"
            >
              {deleting === m.person_id ? <span className="spinner inline" /> : "🗑️"}
            </button>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="roster-dialog-overlay" onClick={onClose}>
      <div className="roster-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>
          👨‍👩‍👧‍👦 家庭花名册
          <span className="subtitle">设备 {deviceSn} 所属家庭 · persons / person_relations 实时快照</span>
          <button className="roster-refresh" onClick={load} disabled={loading}>
            {loading ? <span className="spinner inline" /> : "🔄 刷新"}
          </button>
          <button className="roster-close" onClick={onClose} title="关闭 (Esc)">×</button>
        </h3>

        <div className="roster-dialog-body">
          {error && <div className="roster-error">❌ {error}</div>}

          {roster && !roster.enabled && (
            <div className="roster-disabled">
              记忆系统未启用（memory.enabled=false），无花名册数据。
            </div>
          )}

          {roster?.enabled && (
            <>
              <h4 className="roster-section-title">成员（{roster.members.length}）</h4>
              {roster.members.length > 0 ? (
                <div className="roster-table-wrap">
                  <table className="roster-table">
                    <thead>
                      <tr>
                        <th>person_id</th>
                        <th>名字</th>
                        <th>别名/小名</th>
                        <th>角色</th>
                        <th>性别</th>
                        <th>出生年</th>
                        <th>创建时间</th>
                        <th>更新时间</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>{roster.members.map(renderMemberRow)}</tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">该家庭暂无成员记录（成员由镜头前报名字注册产生）</div>
              )}

              <h4 className="roster-section-title">
                关系边（{roster.relations.length}）
                <span className="subtitle">只存 parent_of / spouse_of 基本边，派生关系现场推理</span>
              </h4>
              {roster.relations.length > 0 ? (
                <div className="roster-relations">
                  {roster.relations.map((r, i) => (
                    <div className="roster-relation-item" key={i}>
                      <span className="roster-relation-text">
                        {relationText(r.subject_id, r.relation, r.object_id)}
                      </span>
                      <code className="roster-relation-raw">
                        ({r.subject_id}, {r.relation}, {r.object_id})
                      </code>
                      <span className="roster-time">{formatTime(r.created_at)}</span>
                      <button
                        className="roster-delete-btn"
                        onClick={() => removeRelation(r)}
                        disabled={relBusy}
                        title="删除这条关系边"
                      >
                        🗑️
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">暂无关系记录</div>
              )}

              {roster.members.length >= 2 && (
                <div className="roster-relation-add">
                  <select className="roster-input" value={relSubject}
                          onChange={(e) => setRelSubject(e.target.value)}>
                    <option value="">选择成员…</option>
                    {roster.members.map((m) => (
                      <option key={m.person_id} value={m.person_id}>{displayName(m.person_id)}</option>
                    ))}
                  </select>
                  <select className="roster-input" value={relKind}
                          onChange={(e) => setRelKind(e.target.value)}>
                    <option value="parent_of">是其父/母 (parent_of)</option>
                    <option value="spouse_of">是其配偶 (spouse_of)</option>
                  </select>
                  <select className="roster-input" value={relObject}
                          onChange={(e) => setRelObject(e.target.value)}>
                    <option value="">选择成员…</option>
                    {roster.members.filter((m) => m.person_id !== relSubject).map((m) => (
                      <option key={m.person_id} value={m.person_id}>{displayName(m.person_id)}</option>
                    ))}
                  </select>
                  <button
                    className="roster-save-btn"
                    onClick={addRelation}
                    disabled={relBusy || !relSubject || !relObject}
                  >
                    ➕ 添加关系
                  </button>
                </div>
              )}

              <details className="roster-prompt-block">
                <summary>抽取提示词中的 {"{ROSTER}"} 块（LLM 实际看到的本家花名册）</summary>
                <pre>{roster.prompt_block}</pre>
              </details>
            </>
          )}

          {loading && !roster && (
            <div className="empty"><div className="spinner" /></div>
          )}
        </div>
      </div>
    </div>
  );
}
