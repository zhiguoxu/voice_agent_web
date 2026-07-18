import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchMemoryBTree, fetchMemoryAItems, fetchRoster,
  eraseDeviceMemory, erasePersonMemory, eraseMemoryItem,
  type MemoryBTreeData, type MemoryAPage, type MemoryItem, type MemoryKeyMeta,
  type RosterMember,
} from "./api";
import "./MemoryDialog.css";

const A_PAGE_SIZE = 20;

/* kind 徽标：state 走值状态机 / event 只累积 / schedule 有时效 */
const KIND_LABELS: Record<string, string> = {
  state: "状态",
  event: "事件",
  schedule: "日程",
};

function formatTime(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN");
}

/** key 点分路径树节点（items 挂在 key 精确匹配的节点上，计数含整棵子树） */
interface KeyTreeNode {
  key: string;                 // 完整点分路径，如 "preference.food.not"
  children: KeyTreeNode[];
  items: MemoryItem[];
}

/** 把平铺的 B 类条目按 key 点分路径建树（.not 镜像自然挂在正叶子下）。 */
function buildKeyTree(items: MemoryItem[]): KeyTreeNode[] {
  const nodeMap = new Map<string, KeyTreeNode>();
  const roots: KeyTreeNode[] = [];

  const ensure = (key: string): KeyTreeNode => {
    let node = nodeMap.get(key);
    if (node) return node;
    node = { key, children: [], items: [] };
    nodeMap.set(key, node);
    const dot = key.lastIndexOf(".");
    if (dot === -1) {
      roots.push(node);
    } else {
      ensure(key.slice(0, dot)).children.push(node);
    }
    return node;
  };

  for (const it of items) {
    if (it.key) ensure(it.key).items.push(it);
  }
  const sortRec = (nodes: KeyTreeNode[]) => {
    nodes.sort((a, b) => a.key.localeCompare(b.key));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function subtreeCount(node: KeyTreeNode): number {
  return node.items.length + node.children.reduce((s, c) => s + subtreeCount(c), 0);
}

/** 主体名字列表（household 条目常见多主体） */
function subjectNames(item: MemoryItem): string {
  return item.subjects.map((s) => s.name).join("、") || "-";
}

/**
 * 记忆清除的共享控制器（对话框级唯一实例，经 props 下传）：
 * 同一时刻只允许一个删除按钮处于“待确认”状态（两步确认，3 秒未确认自动撤防），
 * 删除请求进行中全体清除按钮禁用，防连点误删。
 */
interface EraseControl {
  armedKey: string | null;   // 待确认的按钮 key（"item-<id>" | "person-<pid>" | "device"）
  busyKey: string | null;    // 请求进行中的按钮 key
  arm: (key: string) => void;
  runItemErase: (memoryId: number) => void;
}

/** 两步确认删除按钮：第一次点击进入待确认（红色高亮），再点执行。 */
function EraseBtn({ ctl, k, onRun, tip, label = "🗑", confirmLabel = "确认删除？",
                    className = "roster-delete-btn", disabled = false }: {
  ctl: EraseControl;
  k: string;
  onRun: () => void;
  tip: string;
  label?: string;
  confirmLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const armed = ctl.armedKey === k;
  return (
    <button
      className={`${className} ${armed ? "confirm" : ""}`}
      disabled={disabled || ctl.busyKey !== null}
      data-tip={armed ? undefined : tip}
      onClick={() => (armed ? onRun() : ctl.arm(k))}
    >
      {ctl.busyKey === k ? "删除中…" : armed ? confirmLabel : label}
    </button>
  );
}

function ItemRow({ item, ctl }: { item: MemoryItem; ctl: EraseControl }) {
  return (
    <div className={`memory-item ${item.status === "superseded" ? "superseded" : ""}`}>
      <span className="memory-item-subjects">{subjectNames(item)}</span>
      {item.value && (
        <span className="memory-item-value">
          {item.value}
          {item.is_extremum && <span className="memory-badge extremum">最X</span>}
        </span>
      )}
      <span className="memory-item-content" data-tip={item.content_raw}>
        {item.content}
      </span>
      {item.mem_type === "household" && (
        <span className="memory-badge household">全家</span>
      )}
      {item.due_at && (
        <span className="memory-item-due" data-tip="日程失效时刻（过期后召回自动过滤）">
          ⏰ {formatTime(item.due_at)}
        </span>
      )}
      {item.status === "superseded" && (
        <span className="memory-badge superseded-tag"
              data-tip={item.superseded_by != null ? `被 #${item.superseded_by} 替代` : "已失效（无替代者）"}>
          已失效
        </span>
      )}
      <span className="memory-item-time" data-tip={`条目 #${item.id} · 会话 #${item.session_id}`}>
        {formatTime(item.created_at)}
      </span>
      <EraseBtn ctl={ctl} k={`item-${item.id}`}
                onRun={() => ctl.runItemErase(item.id)}
                tip="删除这条记忆（物理删除不可恢复；在变更历史链上的条目会被拒绝）" />
    </div>
  );
}

function KeyNodeView({ node, keyMeta, ctl }: {
  node: KeyTreeNode;
  keyMeta: Record<string, MemoryKeyMeta>;
  ctl: EraseControl;
}) {
  const meta = keyMeta[node.key];
  return (
    <details className="memory-key-node" open>
      <summary>
        <span className="memory-key-name">
          {meta?.name || node.key.split(".").pop()}
        </span>
        <code className="memory-key-path">{node.key}</code>
        {meta && meta.kind !== "state" && (
          <span className={`memory-badge kind-${meta.kind}`}>
            {KIND_LABELS[meta.kind] || meta.kind}
          </span>
        )}
        <span className="memory-key-count">{subtreeCount(node)}</span>
      </summary>
      <div className="memory-key-body">
        {node.items.map((it) => <ItemRow key={it.id} item={it} ctl={ctl} />)}
        {node.children.map((c) => (
          <KeyNodeView key={c.key} node={c} keyMeta={keyMeta} ctl={ctl} />
        ))}
      </div>
    </details>
  );
}

/**
 * 记忆查询对话框：按会话设备所属家庭展示记忆条目（多家庭同库，不做全库 dump）。
 * 从会话标题行的「🧠 记忆查询」按钮打开（花名册按钮之后）。
 * B 类（key 非空，走确定性状态机）按 key 层级树展示；
 * A 类（key 为空，纯语义、随对话量线性增长）分页表展示，最新在前。
 * 记忆清除（三个粒度，均为物理删除不可恢复）：
 * 单条（行尾 🗑，变更历史链上的条目被引用时后端拒绝并提示）、
 * 按成员（含与他人共享的条目整条删）、整设备（条目 + 抽取日志全清）。
 */
export function MemoryDialog({ deviceSn, onClose }: { deviceSn: string; onClose: () => void }) {
  const [bData, setBData] = useState<MemoryBTreeData | null>(null);
  const [aData, setAData] = useState<MemoryAPage | null>(null);
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [aPage, setAPage] = useState(1);

  /* ── 记忆清除状态（两步确认 + 结果提示） ── */
  const [erasePid, setErasePid] = useState("");
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const armTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, a, roster] = await Promise.all([
        fetchMemoryBTree(deviceSn, includeSuperseded),
        fetchMemoryAItems(deviceSn, aPage, A_PAGE_SIZE),
        fetchRoster(deviceSn),
      ]);
      setBData(b);
      setAData(a);
      setMembers(roster.members);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [deviceSn, includeSuperseded, aPage]);

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

  /* 成功提示几秒后自动消失；失败提示（含“被引用拒绝”的解释）保留到手动关闭或下次操作 */
  useEffect(() => {
    if (!notice || notice.kind !== "ok") return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const arm = useCallback((key: string) => {
    setArmedKey(key);
    if (armTimerRef.current) window.clearTimeout(armTimerRef.current);
    armTimerRef.current = window.setTimeout(() => setArmedKey(null), 3000);
  }, []);

  /** 执行一次清除请求：成功/失败都落到 notice 提示条，成功后整体刷新。 */
  const runErase = useCallback(async (
    key: string, fn: () => Promise<{ message: string }>,
  ) => {
    if (armTimerRef.current) window.clearTimeout(armTimerRef.current);
    setArmedKey(null);
    setBusyKey(key);
    setNotice(null);
    try {
      const r = await fn();
      setNotice({ kind: "ok", text: r.message });
      await load();
    } catch (e: any) {
      setNotice({ kind: "err", text: e.message || String(e) });
    } finally {
      setBusyKey(null);
    }
  }, [load]);

  const ctl: EraseControl = {
    armedKey, busyKey, arm,
    runItemErase: (memoryId) =>
      runErase(`item-${memoryId}`, () => eraseMemoryItem(deviceSn, memoryId)),
  };

  const memberLabel = (m: RosterMember) =>
    m.name || m.aliases[0] || m.person_id;
  const eraseTarget = members.find((m) => m.person_id === erasePid);
  const erasePidLabel = erasePid === "family" ? "全家"
    : eraseTarget ? memberLabel(eraseTarget) : erasePid;

  const enabled = bData?.enabled ?? aData?.enabled;
  const tree = bData ? buildKeyTree(bData.items) : [];
  const aTotalPages = aData ? Math.max(1, Math.ceil(aData.total / aData.page_size)) : 1;

  return (
    <div className="roster-dialog-overlay" onClick={onClose}>
      <div className="roster-dialog memory-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>
          🧠 记忆查询
          <span className="subtitle">设备 {deviceSn} 所属家庭 · memory_items 实时快照</span>
          <button className="roster-refresh" onClick={load} disabled={loading}>
            {loading ? <span className="spinner inline" /> : "🔄 刷新"}
          </button>
          <button className="roster-close" onClick={onClose} data-tip="关闭 (Esc)">×</button>
        </h3>

        <div className="roster-dialog-body">
          {error && <div className="roster-error">❌ {error}</div>}

          {bData && !bData.enabled && (
            <div className="roster-disabled">
              记忆系统未启用（memory.enabled=false），无记忆数据。
            </div>
          )}

          {enabled && (
            <div className="memory-erase-bar">
              <span className="memory-erase-title"
                    data-tip="三个粒度的记忆清除，均为物理删除、不可恢复（与「已失效」不同——失效行仍保留可回溯）">
                🧹 记忆清除
              </span>
              <select
                className="memory-erase-select"
                value={erasePid}
                onChange={(e) => { setErasePid(e.target.value); setArmedKey(null); }}
              >
                <option value="">选择成员…</option>
                {members.map((m) => (
                  <option key={m.person_id} value={m.person_id}>{memberLabel(m)}</option>
                ))}
                <option value="family">全家（家庭整体条目）</option>
              </select>
              <EraseBtn
                ctl={ctl} k={`person-${erasePid}`} className="memory-erase-btn"
                disabled={!erasePid}
                label="清除该成员记忆"
                confirmLabel={`确认清除${erasePidLabel}的全部记忆？`}
                tip="删除此人作为主体的全部记忆条目；与他人共同的经历/计划也会整条删除（对方的这份记忆随之消失）。花名册身份与人脸不受影响。"
                onRun={() => runErase(`person-${erasePid}`,
                                      () => erasePersonMemory(deviceSn, erasePid))}
              />
              <span className="memory-erase-spacer" />
              <EraseBtn
                ctl={ctl} k="device" className="memory-erase-btn device"
                label="清空整个设备记忆"
                confirmLabel="确认清空？全部记忆与抽取日志将被删除"
                tip="删除该设备所属家庭的全部记忆条目和抽取运行日志（含对话原文快照），并丢弃未抽取的对话缓冲。花名册与人脸底库不动。"
                onRun={() => runErase("device", () => eraseDeviceMemory(deviceSn))}
              />
            </div>
          )}

          {notice && (
            <div className={`memory-erase-notice ${notice.kind}`}>
              <span className="memory-erase-notice-text">
                {notice.kind === "ok" ? "✅ " : "⚠️ "}{notice.text}
              </span>
              <button className="memory-erase-notice-close"
                      onClick={() => setNotice(null)} data-tip="关闭提示">×</button>
            </div>
          )}

          {enabled && bData && (
            <>
              <h4 className="roster-section-title">
                B 类记忆（{bData.items.length}）
                <span className="subtitle">有 key 的结构化条目，按注册表 key 层级展示</span>
                <label className="memory-superseded-toggle">
                  <input
                    type="checkbox"
                    checked={includeSuperseded}
                    onChange={(e) => setIncludeSuperseded(e.target.checked)}
                  />
                  含已失效
                </label>
              </h4>
              {tree.length > 0 ? (
                <div className="memory-tree">
                  {tree.map((n) => (
                    <KeyNodeView key={n.key} node={n} keyMeta={bData.key_meta} ctl={ctl} />
                  ))}
                </div>
              ) : (
                <div className="empty">该家庭暂无 B 类记忆</div>
              )}
            </>
          )}

          {enabled && aData && (
            <>
              <h4 className="roster-section-title">
                A 类记忆（{aData.total}）
                <span className="subtitle">无 key 的纯语义条目，只累积去重，最新在前</span>
              </h4>
              {aData.items.length > 0 ? (
                <>
                  <div className="roster-table-wrap">
                    <table className="roster-table memory-a-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>主体</th>
                          <th>内容</th>
                          <th>归属</th>
                          <th>说话人</th>
                          <th>时间</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {aData.items.map((it) => (
                          <tr key={it.id}>
                            <td className="roster-time">{it.id}</td>
                            <td>{subjectNames(it)}</td>
                            <td className="memory-a-content" data-tip={it.content_raw}>
                              {it.content}
                            </td>
                            <td>{it.mem_type === "household"
                              ? <span className="memory-badge household">全家</span> : "个人"}</td>
                            <td>{it.speaker || "-"}</td>
                            <td className="roster-time" data-tip={`会话 #${it.session_id}`}>
                              {formatTime(it.created_at)}
                            </td>
                            <td>
                              <EraseBtn ctl={ctl} k={`item-${it.id}`}
                                        onRun={() => ctl.runItemErase(it.id)}
                                        tip="删除这条记忆（物理删除不可恢复）" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="memory-pagination">
                    <button className="roster-cancel-btn" disabled={loading || aPage <= 1}
                            onClick={() => setAPage(aPage - 1)}>
                      ← 上一页
                    </button>
                    <span className="memory-page-info">
                      第 {aData.page} / {aTotalPages} 页 · 共 {aData.total} 条
                    </span>
                    <button className="roster-cancel-btn" disabled={loading || aPage >= aTotalPages}
                            onClick={() => setAPage(aPage + 1)}>
                      下一页 →
                    </button>
                  </div>
                </>
              ) : (
                <div className="empty">该家庭暂无 A 类记忆</div>
              )}
            </>
          )}

          {loading && !bData && (
            <div className="empty"><div className="spinner" /></div>
          )}
        </div>
      </div>
    </div>
  );
}
