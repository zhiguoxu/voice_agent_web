import type { IdentityDebug } from "./api";
import "./IdentityDebugDialog.css";

/* ── 身份融合调试弹窗 ──
 * 点击轮次卡片右上角的说话人标签打开，展示该轮落库的 identity_debug：
 * 视觉/声纹各自的最像者与分数、镜头者声纹分、融合结论。
 * 数据在 agent_server 融合时采集（resolve.build_identity_debug），
 * 这里只做展示，不再推导。
 */

/** person_id → "名字 (id)"；花名册查不到名字时只显示裸 id */
function personText(pid: string | null, names: Record<string, string>): string {
  if (!pid) return "—";
  const name = names[pid];
  return name ? `${name} (${pid})` : pid;
}

function scoreText(score: number | null | undefined): string {
  return score === null || score === undefined ? "—" : score.toFixed(3);
}

/** 视觉判定档位的中文说明（recognition 归一档；括号内是服务端原始档位） */
function visionJudgeText(recognition: string, status: string | null): string {
  const zh: Record<string, string> = {
    known: "已识别（可直接当作此人）",
    suspected: "疑似（像但没认准，可能认错）",
    unknown: "未识别",
  };
  const base = zh[recognition] ?? recognition;
  return status ? `${base}，原始档位 ${status}` : base;
}

/** 融合仲裁走向的中文说明 */
const FUSION_KIND_TEXT: Record<string, string> = {
  override: "声纹否决视觉：声音极像另一人，本轮身份改判给声音指向的人（疑似级）",
  conflict_unknown: "冲突归未知：声音较强指向他人但不足以断定，本轮不认定身份",
  voice_doubt: "弱冲突：身份仍归镜头里的人，但这句话的声音存疑（标签带「疑似」，记忆不绑人）",
};

export default function IdentityDebugDialog({ debug, conflict, suspected, names, onClose }: {
  debug: IdentityDebug;
  conflict: boolean;
  suspected: boolean;
  names: Record<string, string>;
  onClose: () => void;
}) {
  const { vision, voice, fusion } = debug;
  /* 声纹 top-1 与视觉识别的人不同时，"镜头者自己的声纹分"才有意义（后端也只在
   * 这种仲裁场景计算它，其余为 null——null 显示为"未计算"，与 0 分区分） */
  const visionVoiceDiffer =
    vision.person_id && voice.top_person_id && vision.person_id !== voice.top_person_id;

  return (
    <div className="identity-debug-overlay" onClick={onClose}>
      <div className="identity-debug-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="identity-debug-header">
          <h3>🪪 本轮身份融合过程</h3>
          <div className="identity-debug-flags">
            {conflict && <span className="flag conflict">冲突</span>}
            {suspected && <span className="flag suspected">疑似</span>}
          </div>
          <button className="identity-debug-close" onClick={onClose}>×</button>
        </div>
        <div className="identity-debug-body">

          <section>
            <h4>👁 视觉（摄像头识别，融合前）</h4>
            <div className="kv"><label>最像的人</label><span>{personText(vision.person_id, names)}</span></div>
            <div className="kv"><label>融合匹配分</label><span>{scoreText(vision.fused_score)}</span></div>
            <div className="kv"><label>判定</label><span>{visionJudgeText(vision.recognition, vision.status)}</span></div>
          </section>

          <section>
            <h4>🎙 声纹（本轮说话人声音比对）</h4>
            <div className="kv"><label>最像的人</label><span>{personText(voice.top_person_id, names)}</span></div>
            <div className="kv"><label>相似分</label><span>{scoreText(voice.top_score)}</span></div>
            <div className="kv">
              <label>判定</label>
              <span>
                {voice.confidence
                  ? `${voice.confidence === "high" ? "high（可信，可作兜底身份）" : "low（分数过线但不足采信）"}`
                  : "无结论（未过阈值/声音太短/声纹库为空）"}
              </span>
            </div>
            <div className="kv"><label>净语音时长</label><span>{voice.net_speech_sec.toFixed(1)}s</span></div>
            {visionVoiceDiffer && (
              <div className="kv">
                <label>镜头者声纹分</label>
                <span data-tip="声音最像的不是镜头里的人时，额外算镜头者本人的声纹分做仲裁依据">
                  {debug.vision_person_voice_score === null ? "未计算" : scoreText(debug.vision_person_voice_score)}
                </span>
              </div>
            )}
          </section>

          <section>
            <h4>⚖️ 融合结论（本轮最终采用）</h4>
            <div className="kv"><label>采用身份</label><span>{personText(fusion.person_id, names)}</span></div>
            <div className="kv"><label>置信档</label><span>{visionJudgeText(fusion.recognition, null)}</span></div>
            <div className="kv">
              <label>依据</label>
              <span>{fusion.source === "vision" ? "视觉" : fusion.source === "voice" ? "声纹" : "—"}</span>
            </div>
            {fusion.conflict_kind && (
              <div className="kv"><label>仲裁走向</label><span>{FUSION_KIND_TEXT[fusion.conflict_kind] ?? fusion.conflict_kind}</span></div>
            )}
            {fusion.conflict_kind && vision.person_id && vision.person_id !== fusion.person_id && (
              <div className="kv"><label>仲裁前视觉看到</label><span>{personText(vision.person_id, names)}</span></div>
            )}
          </section>

        </div>
      </div>
    </div>
  );
}
