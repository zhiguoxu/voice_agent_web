import { Fragment } from "react";
import type { MemoryRecall, RecalledMemory, RecallPlan } from "./api";
import "./MemoryRecallPanel.css";

/** 轮次详情面板中的「记忆召回」区块：展示本轮召回的检索计划、命中条目
 *  （含分数与 A/B 池归属）、最终注入提示词的记忆块与各阶段耗时，
 *  用于调试记忆系统是否按预期工作。数据源是随轮次持久化的 RecallTrace。 */

/** 变更链摊平：召回结果只含链头，succ 指针串起旧→新的替代历史 */
function flattenChain(head: RecalledMemory): RecalledMemory[] {
  const chain: RecalledMemory[] = [];
  const seen = new Set<number>();
  let cur: RecalledMemory | null = head;
  while (cur && !seen.has(cur.memory_id)) {
    chain.push(cur);
    seen.add(cur.memory_id);
    cur = cur.succ;
  }
  return chain;
}

function personLabel(pid: string, names: Record<string, string>) {
  return names[pid] ? `${names[pid]}` : pid;
}

/** 融合后的 key 是否出自本轮：own_keys 里有它本身或它的后代即算（祖先塌缩
 *  可能把本轮叶子并进继承来的祖先，此时该祖先仍覆盖本轮结果，不算纯继承）。
 *  旧 trace 无 own_keys 字段（当时 keys 恒为本轮自身结果）→ 全按本轮展示。 */
function keyIsOwn(plan: RecallPlan, k: string): boolean {
  if (!plan.own_keys) return true;
  return plan.own_keys.some((o) => o === k || o.startsWith(k + "."));
}

function PlanChips({ plan, extremumFallback, names }: {
  plan: RecallPlan;
  extremumFallback: boolean;
  names: Record<string, string>;
}) {
  return (
    <div className="recall-plan">
      <span className="recall-chip subjects" title={`检索主体（person_id: ${plan.subjects.join(", ") || "无"}）`}>
        主体: {plan.subjects.length ? plan.subjects.map((p) => personLabel(p, names)).join("、") : "—"}
      </span>
      <span className="recall-chip key" title="命中的 key 注册表节点（可多个；root 按子树展开，叶子取正负镜像对；空 = 纯语义 A 类检索）。虚线下划线 = 上下文融合从上文继承的 key">
        key: {plan.keys?.length ? plan.keys.map((k, i) => (
          <Fragment key={k}>
            {i > 0 && "、"}
            <span className={keyIsOwn(plan, k) ? "" : "recall-key-inherited"}
                  title={keyIsOwn(plan, k) ? undefined
                    : "从上文继承：本轮 query 没扣出这个 key，是上下文融合并入的最近一次扣出结果（联想式过召，交模型分辨）"}>
              {k}
            </span>
          </Fragment>
        )) : "—"}
      </span>
      {plan.extremum && <span className="recall-chip flag" title="“最X”类查询：只取极值条目">极值</span>}
      {extremumFallback && (
        <span className="recall-chip fallback"
              title="没有任何带“最”标志的记录，已放开极值条件按普通同类条目召回；注入块里提示模型不要断言哪个是“最”">
          极值回落
        </span>
      )}
      {plan.reverse && <span className="recall-chip flag" title="“谁…”反查：不按主体过滤，答案在命中条目的主体里">反查</span>}
      {plan.temporal === "history" && <span className="recall-chip flag" title="“以前/曾经”：放开已失效的旧记忆">历史</span>}
      {plan.confidence === "low" && <span className="recall-chip low" title="主体消解不确定">低置信</span>}
      {plan.key_candidates && plan.key_candidates.length > 0 && (
        <div className="recall-candidates"
             data-hover={"双塔模型的原始 top5 打分，仅供调试；上方 key: 才是结论\n划线 = 不是合法 key，已被过滤\nkey 为 — 而这里有值 = 模型弃权（没找到足够相关的类别）"}>
          双塔:
          {plan.key_candidates.map((c) => (
            <span key={c.raw} className={`recall-candidate ${c.key ? "" : "dropped"}`}>
              {c.raw}{c.key && c.key !== c.raw ? `→${c.key}` : ""} {c.score.toFixed(3)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordRow({ record }: { record: RecalledMemory }) {
  const chain = flattenChain(record);
  return (
    <div className="recall-record">
      <div className="recall-record-head">
        <span className={`recall-pool ${record.tag ? "b" : "a"}`}
              title={record.tag ? "B 池：有 key 的结构化条目（索引命中）" : "A 池：无 key 的条目（语义召回）"}>
          {record.tag ? "B" : "A"}
        </span>
        {record.score != null && (
          <span className="recall-score" title="召回打分（与查询向量的点积；嵌入服务故障时为字面覆盖率兜底分）">
            {record.score.toFixed(3)}
          </span>
        )}
        <span className="recall-mid" title="记忆条目在记忆库(memory_items)中的行 ID，非排名；列表顺序即召回排名">
          id:{record.memory_id}
        </span>
        {record.subject_names.length > 0 && (
          <span className="recall-subjects">{record.subject_names.join("、")}</span>
        )}
      </div>
      {chain.map((m, i) => (
        <div key={m.memory_id} className={`recall-content ${m.status !== "active" ? "superseded" : ""}`}>
          {chain.length > 1 && <span className="recall-chain-step">{i === 0 ? "旧" : "新"}</span>}
          <span>{m.content}</span>
          {m.tag && (
            <code className="recall-tag">
              {m.tag.key} = {m.tag.value}{m.tag.is_extremum ? "（最）" : ""}
            </code>
          )}
          {m.due_at && <span className="recall-due">📅 {m.due_at.slice(0, 10)}</span>}
          {m.status !== "active" && (
            <span className="recall-status" title={m.superseded_at ? `失效于 ${m.superseded_at}` : ""}>已过时</span>
          )}
        </div>
      ))}
      {record.chain_open && <div className="recall-content superseded">（后又有更新，未在召回窗口内）</div>}
    </div>
  );
}

export function MemoryRecallPanel({ recall, names }: {
  recall: MemoryRecall | null | undefined;
  names: Record<string, string>;
}) {
  if (!recall) {
    return <div className="recall-empty">本轮无召回记录（记忆系统未启用，或为升级前的旧数据）</div>;
  }
  /* 极值回落判定：计划要求“最”但命中里没有任何极值行（严格通路非空必含极值行，
     与后端 _format_block 的判定一致） */
  const extremumFallback = !!recall.plan?.extremum && recall.records.length > 0 &&
    !recall.records.some((r) => r.tag?.is_extremum);
  return (
    <div className="recall-panel">
      {recall.error && (
        <div className="recall-error" title="召回中途异常，本轮已降级为无记忆注入">⚠️ 召回异常降级：{recall.error}</div>
      )}

      {recall.plan ? (
        <PlanChips plan={recall.plan} extremumFallback={extremumFallback} names={names} />
      ) : (
        !recall.error && <div className="recall-empty">未生成检索计划</div>
      )}

      <div className="recall-timing">
        {recall.plan_ms != null && <span>查询理解 {recall.plan_ms}ms</span>}
        {recall.search_ms != null && <span>检索 {recall.search_ms}ms</span>}
        {recall.total_ms != null && <span>共 {recall.total_ms}ms</span>}
      </div>

      {recall.records.length > 0 ? (
        <div className="recall-records">
          {recall.records.map((r) => <RecordRow key={r.memory_id} record={r} />)}
        </div>
      ) : (
        recall.plan && !recall.error && <div className="recall-empty">未命中任何记忆条目</div>
      )}

      <details className="recall-block">
        <summary>{recall.block ? "注入提示词的记忆块" : "本轮未注入记忆块"}</summary>
        {recall.block && <pre>{recall.block}</pre>}
      </details>
    </div>
  );
}
