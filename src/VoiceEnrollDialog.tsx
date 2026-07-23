import { useEffect, useRef, useState } from "react";
import {
  startVoiceEnroll, finishVoiceEnroll, cancelVoiceEnroll, deleteVoiceprint,
  type VoiceEnrollFinishResult,
} from "./api";
import "./RosterDialog.css";
import "./FaceRegisterDialog.css";
import "./VoiceEnrollDialog.css";

/** 引导文本备选（音素覆盖较全的日常段落，正常语速约 12~20 秒） */
const PASSAGES: string[] = [
  "今天天气真不错，阳光透过窗户洒进屋里。小猫在沙发上打了个哈欠，慢悠悠地伸了个懒腰。我打算下午去公园散散步，顺便买点新鲜的水果回来。",
  "周末的早晨，厨房里飘着小米粥和煎鸡蛋的香味。爷爷在阳台上给花浇水，妹妹趴在桌边画画，收音机里正播着一首老歌，家里显得格外热闹。",
  "傍晚的风轻轻吹过树梢，路边的灯一盏一盏亮了起来。我们沿着河边慢慢走，聊起了小时候的趣事，不知不觉就到了家门口，晚饭已经准备好了。",
  "书架上摆满了各种各样的书，有讲历史的，有讲科学的，还有几本厚厚的画册。每天睡觉前翻上几页，既能长知识，又能让心情安静下来。",
  "春天到了，院子里的桃树开满了粉红色的花。蜜蜂在花丛中飞来飞去，忙着采蜜。奶奶说，等到夏天，枝头就会结出又大又甜的桃子。",
  "火车缓缓驶出车站，窗外的风景不断变换，从高楼大厦到田野山川。我靠在座位上，喝了一口热茶，想着这次旅行会遇到哪些有意思的人和事。",
];

/** 编辑过的引导文本存本地；未编辑时每次打开随机换一段 */
const TEXT_STORAGE_KEY = "voiceEnrollText";

function pickRandomPassage(): string {
  return PASSAGES[Math.floor(Math.random() * PASSAGES.length)];
}

function initialText(): string {
  return localStorage.getItem(TEXT_STORAGE_KEY) || pickRandomPassage();
}

type Phase = "idle" | "starting" | "reading" | "checking" | "done";

/**
 * 声纹录入对话框：从花名册成员行的「🎤」按钮打开，给该成员补录声纹
 * （须已完成人脸注册，person_id 直接取自花名册，不依赖实时视频流）。
 *
 * 两段交互：「开始录入」打开设备侧采集并语音提示用户照下面的文本朗读；
 * 用户读完点「完成朗读」由后端评估质量，无论成败本次流程即结束（设备
 * 播报结果，这里同步展示）。质量不合格时是否重试由用户决定——失败结果
 * 页点「重新录入」回到开始页再来一遍，次数不限。
 */
export function VoiceEnrollDialog({ deviceSn, personId, personName, voiceTemplates, onChanged, onClose }: {
  deviceSn: string;
  personId: string;
  personName: string;
  /** 打开时该成员已有的声纹模板条数（0=未录入） */
  voiceTemplates: number;
  /** 声纹发生增删后回调（花名册刷新模板数用） */
  onChanged: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState<string>(initialText);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<VoiceEnrollFinishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* 已有声纹的删除入口：两步确认（3 秒内再点才执行，与花名册删成员同交互） */
  const [templatesLeft, setTemplatesLeft] = useState(voiceTemplates);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const armTimerRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  /* 录入进行中关闭对话框（含 Esc）要顺手取消采集，恢复设备对话链路 */
  const close = () => {
    if (phaseRef.current === "reading" || phaseRef.current === "checking"
        || phaseRef.current === "starting") {
      cancelVoiceEnroll(deviceSn).catch(() => {});
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editText = (value: string) => {
    setText(value);
    localStorage.setItem(TEXT_STORAGE_KEY, value);
  };

  const shufflePassage = () => {
    /* 换一段 = 放弃本地编辑稿，回到随机默认文本 */
    localStorage.removeItem(TEXT_STORAGE_KEY);
    let next = pickRandomPassage();
    while (PASSAGES.length > 1 && next === text) next = pickRandomPassage();
    setText(next);
  };

  const start = async () => {
    setPhase("starting");
    setError(null);
    setNotice(null);
    try {
      const r = await startVoiceEnroll(deviceSn, personId);
      if (!r.success) {
        setError(r.message);
        setPhase("idle");
        return;
      }
      setPhase("reading");
    } catch (e: any) {
      setError(e.message || String(e));
      setPhase("idle");
    }
  };

  const finish = async () => {
    setPhase("checking");
    setError(null);
    try {
      /* 无论成败流程都结束；质量不合格时结果页点「重新录入」再来一遍 */
      const r = await finishVoiceEnroll(deviceSn);
      setResult(r);
      setPhase("done");
      if (r.success) {
        setTemplatesLeft(1);
        onChanged();
      }
    } catch (e: any) {
      setError(e.message || String(e));
      setPhase("reading");
    }
  };

  const armDelete = () => {
    setDeleteArmed(true);
    if (armTimerRef.current) window.clearTimeout(armTimerRef.current);
    armTimerRef.current = window.setTimeout(() => setDeleteArmed(false), 3000);
  };

  const confirmDelete = async () => {
    if (armTimerRef.current) window.clearTimeout(armTimerRef.current);
    setDeleteArmed(false);
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      const r = await deleteVoiceprint(personId, deviceSn);
      if (!r.success) {
        setError(r.message);
        return;
      }
      setTemplatesLeft(0);
      setNotice(r.message);
      onChanged();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setDeleting(false);
    }
  };

  const reading = phase === "reading" || phase === "checking";

  return (
    <div className="roster-dialog-overlay" onClick={close}>
      <div className="roster-dialog voice-enroll-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>
          🎤 声纹录入
          <span className="subtitle">{personName} · 设备 {deviceSn}</span>
          <button className="roster-close" onClick={close} data-tip="关闭 (Esc)">×</button>
        </h3>

        <div className="roster-dialog-body">
          {phase === "idle" && (
            <p className="face-register-hint">
              让「{personName}」本人在设备旁准备好后点「开始录入」：设备会语音提示
              TA 用平时说话的音量朗读下面的文字，读完后回到这里点「完成朗读」。
              质量不合格时设备会播报原因，想重试就再点一次「开始录入」，次数
              不限。文本可直接编辑（自动保存在本浏览器），也可以换一段随机默认文本。
            </p>
          )}

          <div className={`voice-enroll-passage ${reading ? "reading" : ""}`}>
            {phase === "idle" ? (
              <textarea
                className="voice-enroll-textarea"
                value={text}
                rows={5}
                onChange={(e) => editText(e.target.value)}
              />
            ) : (
              <div className="voice-enroll-passage-text">{text}</div>
            )}
          </div>

          {phase === "idle" && (
            <div className="voice-enroll-actions">
              {templatesLeft > 0 && (
                <span className="voice-enroll-existing">
                  已有 {templatesLeft} 条声纹模板，重新录入会覆盖
                </span>
              )}
              {templatesLeft > 0 && (deleteArmed ? (
                <button className="roster-delete-btn confirm" onClick={confirmDelete}
                        data-tip="再次点击确认：删除该成员的全部声纹模板（人脸/花名册/记忆保留，此后声音不再被认出）">
                  确认删除
                </button>
              ) : (
                <button className="roster-delete-btn" onClick={armDelete} disabled={deleting}
                        data-tip="删除该成员的全部声纹模板（人脸/花名册/记忆保留），可随时重录">
                  {deleting ? <span className="spinner inline" /> : "🗑️ 删除声纹"}
                </button>
              ))}
              <button className="roster-cancel-btn" onClick={shufflePassage}
                      data-tip="随机换一段默认文本（放弃本地编辑稿）">
                🎲 换一段
              </button>
              <button className="roster-save-btn" onClick={start} disabled={!text.trim()}>
                开始录入
              </button>
            </div>
          )}

          {notice && phase === "idle" && (
            <div className="face-register-result ok">✅ {notice}</div>
          )}

          {phase === "starting" && (
            <div className="face-register-result running">⏳ 正在开启设备采集……</div>
          )}

          {reading && (
            <>
              <div className="face-register-result running">
                🎙️ 正在聆听……请让「{personName}」用平时说话的音量朗读上面的
                文字，读完后点「完成朗读」
              </div>
              <div className="voice-enroll-actions">
                <button className="roster-cancel-btn" onClick={close}
                        disabled={phase === "checking"}>
                  取消录入
                </button>
                <button className="roster-save-btn" onClick={finish}
                        disabled={phase === "checking"}>
                  {phase === "checking" ? <span className="spinner inline" /> : "完成朗读"}
                </button>
              </div>
            </>
          )}

          {phase === "done" && result && (
            <>
              <div className={`face-register-result ${result.success ? "ok" : "fail"}`}>
                {result.success ? "✅" : "❌"} {result.message}
                {result.person_id && (
                  <div className="face-register-pid">person_id: {result.person_id}</div>
                )}
              </div>
              <div className="voice-enroll-actions">
                {!result.success && (
                  <button className="roster-save-btn" onClick={() => {
                    setResult(null);
                    setPhase("idle");
                  }}>
                    重新录入
                  </button>
                )}
                <button className="roster-cancel-btn" onClick={onClose}>关闭</button>
              </div>
            </>
          )}

          {error && <div className="face-register-result fail">❌ {error}</div>}
        </div>
      </div>
    </div>
  );
}
