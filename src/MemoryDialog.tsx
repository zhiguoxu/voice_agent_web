import { useState, useEffect, useCallback } from "react";
import {
  fetchMemoryBTree, fetchMemoryAItems,
  type MemoryBTreeData, type MemoryAPage, type MemoryItem, type MemoryKeyMeta,
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

function ItemRow({ item }: { item: MemoryItem }) {
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
    </div>
  );
}

function KeyNodeView({ node, keyMeta }: {
  node: KeyTreeNode;
  keyMeta: Record<string, MemoryKeyMeta>;
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
        {node.items.map((it) => <ItemRow key={it.id} item={it} />)}
        {node.children.map((c) => (
          <KeyNodeView key={c.key} node={c} keyMeta={keyMeta} />
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
 */
export function MemoryDialog({ deviceSn, onClose }: { deviceSn: string; onClose: () => void }) {
  const [bData, setBData] = useState<MemoryBTreeData | null>(null);
  const [aData, setAData] = useState<MemoryAPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [aPage, setAPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, a] = await Promise.all([
        fetchMemoryBTree(deviceSn, includeSuperseded),
        fetchMemoryAItems(deviceSn, aPage, A_PAGE_SIZE),
      ]);
      setBData(b);
      setAData(a);
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
                    <KeyNodeView key={n.key} node={n} keyMeta={bData.key_meta} />
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
