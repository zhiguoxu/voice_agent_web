import { useState } from 'react';
import type { Turn } from './api';

export function LatencyChart({ turn }: { turn: Turn }) {
  // 使用最早可用的时间戳作为基准（兼容无 VAD 的文本输入场景）
  const t0 = turn.t_vad_end || turn.t_asr_done || turn.t_agent_start;
  if (!t0) return null;

  // tEnd 仅包含甘特条实际终点，不含 t_agent_done/t_agent_start 等非条形终点
  const tEnd = Math.max(
    turn.t_tts_first_audio || 0,
    turn.t_first_token || 0,
    turn.t_llm_first_token || 0,
    turn.t_tool_execute_done || 0,
    turn.t_llm_tool_done || 0,
    turn.t_subagent_done || 0,
    turn.t_emote_action_done || 0,
    turn.t_bert_done || 0,
    turn.t_asr_done || 0,
    turn.t_stateless_start || 0,
    turn.t_memory_done || 0,
    turn.t_names_done || 0,
    turn.t_identity_done || 0,
    turn.t_history_done || 0,
  );
  if (tEnd <= t0) return <div className="empty-media">暂无完整耗时数据</div>;

  const total = tEnd - t0;
  
  const toPercent = (start: number | null, end: number | null) => {
    if (!start || !end) return { left: '0%', width: '0%' };
    const left = Math.max(0, start - t0) / total * 100;
    const width = Math.max(0, end - start) / total * 100;
    return { left: `${left}%`, width: `${width}%` };
  };

  const formatMs = (start: number | null, end: number | null) => {
    if (!start || !end) return "-";
    const ms = ((end - start) * 1000).toFixed(0);
    return <>{ms}<span className="latency-unit">ms</span></>;
  };

  // Pipeline phases
  const ttsStart = turn.t_first_token || turn.t_llm_first_token || turn.t_subagent_done || turn.t_bert_done || turn.t_agent_start;
  type Phase = { label: string; start: number | null; end: number | null; color: string; tooltip?: string };
  const phases: Phase[] = [];
  if (turn.t_asr_done && turn.t_vad_end && turn.t_asr_done - turn.t_vad_end > 0.001) {
    phases.push({ label: "ASR识别", start: turn.t_vad_end, end: turn.t_asr_done, color: "var(--purple)" });
  }

  // 上下文准备阶段（chat 入口 → chat_stateless 入口）：历史查询与身份识别并发，
  // 之后依次是名字查询、记忆召回。低于 1ms 的退化阶段（如功能未启用）不展示。
  const pushIfVisible = (label: string, start: number | null, end: number | null, color: string) => {
    if (start && end && end - start > 0.001) phases.push({ label, start, end, color });
  };
  pushIfVisible("历史查询", turn.t_agent_start, turn.t_history_done, "var(--blue)");
  pushIfVisible("身份识别", turn.t_agent_start, turn.t_identity_done, "var(--purple)");
  const ctxGatherDone = Math.max(turn.t_history_done || 0, turn.t_identity_done || 0) || null;
  pushIfVisible("名字查询", ctxGatherDone, turn.t_names_done, "var(--cyan)");
  pushIfVisible("记忆召回", turn.t_names_done, turn.t_memory_done, "var(--green)");
  pushIfVisible("请求构造", turn.t_memory_done, turn.t_stateless_start, "var(--orange)");

  if (turn.t_bert_start && turn.t_bert_done) {
    phases.push({ label: "BERT调用", start: turn.t_bert_start, end: turn.t_bert_done, color: "var(--red)" });
  }

  if (turn.t_subagent_start && turn.t_subagent_done) {
    const label = turn.subagent_name ? `${turn.subagent_name}调用` : "Agent调用";
    phases.push({ label, start: turn.t_subagent_start, end: turn.t_subagent_done, color: "var(--blue)" });
  }

  // 动作/表情生成：与 LLM 生成并行的后台任务，条形与主链路重叠属正常。
  // 只有 start 没有 done 时不渲染，两种正常成因（数据性质而非 bug）：
  //   1. 落库数据：任务是 fire-and-forget，比本轮持久化晚结束则 done 未写入；
  //   2. 复现数据：done 事件在主流式结束时快照 timing，任务未跑完则快照里无 done。
  if (turn.t_emote_action_start && turn.t_emote_action_done) {
    const sent = [
      turn.emote_action_sent ? `动作: ${turn.emote_action_sent}` : null,
      turn.emote_face_sent ? `表情: ${turn.emote_face_sent}` : null,
    ].filter(Boolean).join('\n');
    phases.push({ label: "动作表情生成", start: turn.t_emote_action_start, end: turn.t_emote_action_done, color: "var(--purple)", tooltip: sent || undefined });
  }

  if (turn.t_llm_tool_start && turn.t_llm_tool_done) {
    const tooltip = turn.tool_arguments ? turn.tool_arguments : undefined;
    phases.push({ label: "LLM决策工具", start: turn.t_llm_tool_start, end: turn.t_llm_tool_done, color: "var(--orange)", tooltip });
  }

  if (turn.t_tool_execute_start && turn.t_tool_execute_done) {
    const label = turn.tool_names ? `工具执行(${turn.tool_names})` : "工具执行";
    const tooltip = turn.tool_results ? turn.tool_results : undefined;
    phases.push({ label, start: turn.t_tool_execute_start, end: turn.t_tool_execute_done, color: "var(--blue)", tooltip });
  }

  phases.push(
    { label: "LLM首字", start: turn.t_llm_start, end: turn.t_llm_first_token, color: "var(--orange)" },
    { label: "首字回复", start: turn.t_agent_start, end: turn.t_first_token, color: "var(--cyan)" },
    { label: "TTS首包", start: ttsStart, end: turn.t_tts_first_audio, color: "var(--green)" }
  );

  const [modalData, setModalData] = useState<{title: string, content: string} | null>(null);

  return (
    <>
      <div className="latency-chart">
        <div className="latency-axis">
          <span>0ms</span>
          <span className="latency-total-highlight">{(total * 1000).toFixed(0)}<span style={{marginLeft: 2}}>ms</span></span>
        </div>
        <div className="latency-bars">
          {phases.map((p, idx) => {
            if (!p.start || !p.end) return null;
            const { left, width } = toPercent(p.start, p.end);
            // 悬浮提示: 相对本轮起点的精确起止时间。短阶段(毫秒级)在长轮次
            // 的横轴上会被压成亚像素小块, 悬浮是唯一能读出真实区间的途径。
            // 用 CSS 伪元素而非原生 title: title 有浏览器内置 ~1s 延迟且不可配。
            const startMs = (p.start - t0) * 1000;
            const endMs = (p.end - t0) * 1000;
            const hoverTitle = `${p.label}: ${startMs.toFixed(1)}ms → ${endMs.toFixed(1)}ms（耗时 ${(endMs - startMs).toFixed(1)}ms）`;
            return (
              <div key={idx} className="latency-row" data-hover={hoverTitle}>
                <div className="latency-label">
                  <div>
                    {p.label}
                    {p.tooltip && (
                      <button 
                        className="latency-detail-btn"
                        onClick={() => {
                          let title = p.label;
                          if (p.label.includes('决策工具')) title += ' (参数)';
                          else if (p.label.includes('工具执行')) title += ' 结果';
                          setModalData({ title, content: p.tooltip! });
                        }}
                      >
                        详情
                      </button>
                    )}
                  </div>
                  <span className="latency-val">{formatMs(p.start, p.end)}</span>
                </div>
                <div className="latency-bar-track">
                  <div
                    className="latency-bar-fill"
                    style={{ left, width, backgroundColor: p.color, opacity: p.label === 'LLM生成' ? 0.3 : 1 }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {modalData && (
        <div className="latency-modal-overlay" onClick={() => setModalData(null)}>
          <div className="latency-modal-content" onClick={e => e.stopPropagation()}>
            <div className="latency-modal-header">
              <h3>{modalData.title}</h3>
              <button className="latency-modal-close" onClick={() => setModalData(null)}>×</button>
            </div>
            <div className="latency-modal-body">
              <pre>{modalData.content}</pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
