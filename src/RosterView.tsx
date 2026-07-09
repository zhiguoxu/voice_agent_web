import { useState, useEffect, useCallback, useRef } from "react";
import { fetchRoster, deleteRosterMember, type RosterData, type RosterMember } from "./api";
import "./RosterView.css";

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

export function RosterView() {
  const [roster, setRoster] = useState<RosterData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* 两步确认删除：第一次点进入待确认态（3 秒内再点才执行），避免误触 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const pendingTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoster(await fetchRoster());
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
      await deleteRosterMember(personId);
      await load();
    } catch (e: any) {
      setError(`删除失败: ${e.message || String(e)}`);
    } finally {
      setDeleting(null);
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

  const renderMemberRow = (m: RosterMember) => (
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
      <td>
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
            disabled={deleting === m.person_id}
            title="删除该成员（会先清理其全部关系边）"
          >
            {deleting === m.person_id ? <span className="spinner inline" /> : "🗑️"}
          </button>
        )}
      </td>
    </tr>
  );

  return (
    <div className="roster-container">
      <div className="card">
        <h3>
          👨‍👩‍👧‍👦 家庭花名册
          <span className="subtitle">记忆库 persons / person_relations 表实时快照，供调试</span>
          <button className="roster-refresh" onClick={load} disabled={loading}>
            {loading ? <span className="spinner inline" /> : "🔄 刷新"}
          </button>
        </h3>

        {error && <div className="roster-error">❌ 加载失败: {error}</div>}

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
              <div className="empty">暂无成员记录</div>
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
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">暂无关系记录</div>
            )}

            <details className="roster-prompt-block">
              <summary>抽取提示词中的 {"{ROSTER}"} 块（LLM 实际看到的花名册）</summary>
              <pre>{roster.prompt_block}</pre>
            </details>
          </>
        )}

        {loading && !roster && (
          <div className="empty"><div className="spinner" /></div>
        )}
      </div>
    </div>
  );
}
