import { useState } from 'react';
import type { Turn } from './api';

// 阶段的稳定 key 及其时序顺序: buildPhases 对任意 Turn 产出的阶段列表都是
// 该序列的子序列, 复现图与原轮次图按 key 合并即可逐行对齐
const PHASE_KEY_ORDER = [
  'asr', 'history', 'identity', 'vision_gate', 'names', 'memory',
  'build_request', 'intent', 'subagent', 'emote_action',
  'llm_tool', 'tool_execute', 'llm_first', 'first_token', 'tts',
] as const;

type PhaseKey = typeof PHASE_KEY_ORDER[number];
type Phase = {
  key: PhaseKey;
  label: string;
  start: number | null;
  end: number | null;
  color: string;
  tooltip?: string;
  // 占位行(复现图专用): 原轮次执行过、本次复现未执行的阶段, 只画灰色标签不画条
  skipped?: boolean;
};

// 由轮次打点构造甘特阶段列表(主页面轮次详情与复现弹窗共用同一套规则)
function buildPhases(turn: Turn): Phase[] {
  const phases: Phase[] = [];

  if (turn.t_asr_done && turn.t_vad_end && turn.t_asr_done - turn.t_vad_end > 0.001) {
    phases.push({ key: 'asr', label: "ASR识别", start: turn.t_vad_end, end: turn.t_asr_done, color: "var(--purple)" });
  }

  // 上下文准备阶段（chat 入口 → chat_stateless 入口）：历史查询与身份识别并发，
  // 之后依次是名字查询、记忆召回。低于 1ms 的退化阶段（如功能未启用）不展示。
  const pushIfVisible = (key: PhaseKey, label: string, start: number | null, end: number | null, color: string) => {
    if (start && end && end - start > 0.001) phases.push({ key, label, start, end, color });
  };
  pushIfVisible('history', "历史查询", turn.t_agent_start, turn.t_history_done, "var(--blue)");
  pushIfVisible('identity', "身份识别", turn.t_agent_start, turn.t_identity_done, "var(--purple)");
  // 视觉门控：与历史/身份并发的第三条腿（仅带图轮才有）；决策快照见详情面板
  if (turn.t_vision_gate_start && turn.t_vision_gate_done
      && turn.t_vision_gate_done - turn.t_vision_gate_start > 0.001) {
    const g = turn.vision_gate;
    const tip = g ? [
      g.decision === "skip" ? "决策: 省图" : "决策: 带图",
      g.p_vision != null ? `P(vision)=${g.p_vision.toFixed(3)}` : null,
      g.threshold != null ? `阈值=${g.threshold}` : null,
      g.reason === "error" ? "门控异常(fail-open)" : null,
    ].filter(Boolean).join('\n') : undefined;
    phases.push({ key: 'vision_gate', label: "视觉门控", start: turn.t_vision_gate_start,
                  end: turn.t_vision_gate_done, color: "var(--cyan)", tooltip: tip });
  }
  const ctxGatherDone = Math.max(turn.t_history_done || 0, turn.t_identity_done || 0) || null;
  pushIfVisible('names', "名字查询", ctxGatherDone, turn.t_names_done, "var(--cyan)");
  pushIfVisible('memory', "记忆召回", turn.t_names_done, turn.t_memory_done, "var(--green)");
  // 请求构造起点: 常规轮是记忆召回完成; 复现轮(无状态, 没有上下文准备打点)
  // 退到 t_agent_start——该段即"请求到达 → 进入无状态入口"(含提示词重装)
  const buildStart = turn.t_memory_done || turn.t_names_done || ctxGatherDone || turn.t_agent_start;
  pushIfVisible('build_request', "请求构造", buildStart, turn.t_stateless_start, "var(--orange)");

  if (turn.t_intent_start && turn.t_intent_done) {
    phases.push({ key: 'intent', label: "意图分类", start: turn.t_intent_start, end: turn.t_intent_done, color: "var(--red)" });
  }

  if (turn.t_subagent_start && turn.t_subagent_done) {
    const label = turn.subagent_name ? `${turn.subagent_name}调用` : "Agent调用";
    phases.push({ key: 'subagent', label, start: turn.t_subagent_start, end: turn.t_subagent_done, color: "var(--blue)" });
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
    phases.push({ key: 'emote_action', label: "动作表情生成", start: turn.t_emote_action_start, end: turn.t_emote_action_done, color: "var(--purple)", tooltip: sent || undefined });
  }

  if (turn.t_llm_tool_start && turn.t_llm_tool_done) {
    const tooltip = turn.tool_arguments ? turn.tool_arguments : undefined;
    phases.push({ key: 'llm_tool', label: "LLM决策工具", start: turn.t_llm_tool_start, end: turn.t_llm_tool_done, color: "var(--orange)", tooltip });
  }

  if (turn.t_tool_execute_start && turn.t_tool_execute_done) {
    const label = turn.tool_names ? `工具执行(${turn.tool_names})` : "工具执行";
    const tooltip = turn.tool_results ? turn.tool_results : undefined;
    phases.push({ key: 'tool_execute', label, start: turn.t_tool_execute_start, end: turn.t_tool_execute_done, color: "var(--blue)", tooltip });
  }

  const ttsStart = turn.t_first_token || turn.t_llm_first_token || turn.t_subagent_done || turn.t_intent_done || turn.t_agent_start;
  phases.push(
    { key: 'llm_first', label: "LLM首字", start: turn.t_llm_start, end: turn.t_llm_first_token, color: "var(--orange)" },
    { key: 'first_token', label: "首字回复", start: turn.t_agent_start, end: turn.t_first_token, color: "var(--cyan)" },
    { key: 'tts', label: "TTS首包", start: ttsStart, end: turn.t_tts_first_audio, color: "var(--green)" }
  );

  return phases.filter(p => p.start && p.end);
}

// baseline: 复现弹窗传入被复现的原轮次, 甘特行按原轮次骨架逐行对齐——
// 原轮次有、本次复现没有的阶段(上下文准备已固化在快照; ASR/TTS 复现不运行)
// 显示为灰色"未执行"占位行, 方便与主页面的图逐行对照
export function LatencyChart({ turn, baseline }: { turn: Turn; baseline?: Turn }) {
  const [modalData, setModalData] = useState<{title: string, content: string} | null>(null);

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
    turn.t_intent_done || 0,
    turn.t_asr_done || 0,
    turn.t_stateless_start || 0,
    turn.t_memory_done || 0,
    turn.t_names_done || 0,
    turn.t_identity_done || 0,
    turn.t_vision_gate_done || 0,
    turn.t_history_done || 0,
  );
  if (tEnd <= t0) return <div className="empty-media">暂无完整耗时数据</div>;

  const total = tEnd - t0;

  const toPercent = (start: number, end: number) => {
    const left = Math.max(0, start - t0) / total * 100;
    const width = Math.max(0, end - start) / total * 100;
    return { left: `${left}%`, width: `${width}%` };
  };

  const formatMs = (start: number, end: number) => {
    const ms = ((end - start) * 1000).toFixed(0);
    return <>{ms}<span className="latency-unit">ms</span></>;
  };

  const phases = buildPhases(turn);
  let rows: Phase[] = phases;
  if (baseline) {
    const have = new Set(phases.map(p => p.key));
    const placeholders = buildPhases(baseline)
      .filter(p => !have.has(p.key))
      .map(p => ({ ...p, start: null, end: null, skipped: true }));
    rows = [...phases, ...placeholders].sort(
      (a, b) => PHASE_KEY_ORDER.indexOf(a.key) - PHASE_KEY_ORDER.indexOf(b.key));
  }

  return (
    <>
      <div className="latency-chart">
        <div className="latency-axis">
          <span>0ms</span>
          <span className="latency-total-highlight">{(total * 1000).toFixed(0)}<span style={{marginLeft: 2}}>ms</span></span>
        </div>
        <div className="latency-bars">
          {rows.map((p, idx) => {
            if (p.skipped) {
              return (
                <div key={idx} className="latency-row latency-row-skipped"
                     data-tip={`${p.label}: 本次复现未执行该阶段（上下文准备结果已固化在请求快照，ASR/TTS 不运行）`}>
                  <div className="latency-label">
                    <div>{p.label}</div>
                    <span className="latency-val latency-val-skipped">未执行</span>
                  </div>
                  <div className="latency-bar-track" />
                </div>
              );
            }
            const { left, width } = toPercent(p.start!, p.end!);
            // 悬浮提示: 相对本轮起点的精确起止时间。短阶段(毫秒级)在长轮次
            // 的横轴上会被压成亚像素小块, 悬浮是唯一能读出真实区间的途径。
            // 用 CSS 伪元素而非原生 title: title 有浏览器内置 ~1s 延迟且不可配。
            const startMs = (p.start! - t0) * 1000;
            const endMs = (p.end! - t0) * 1000;
            const hoverTitle = `${p.label}: ${startMs.toFixed(1)}ms → ${endMs.toFixed(1)}ms（耗时 ${(endMs - startMs).toFixed(1)}ms）`;
            return (
              <div key={idx} className="latency-row" data-tip={hoverTitle}>
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
                  <span className="latency-val">{formatMs(p.start!, p.end!)}</span>
                </div>
                <div className="latency-bar-track">
                  <div
                    className="latency-bar-fill"
                    style={{ left, width, backgroundColor: p.color }}
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
