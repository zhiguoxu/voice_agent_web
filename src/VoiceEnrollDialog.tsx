import { useEffect, useRef, useState } from "react";
import {
  startVoiceEnroll, finishVoiceEnroll, cancelVoiceEnroll, deleteVoiceprint,
  fetchVoiceTemplates, deleteVoiceTemplate, cosMediaUrl,
  type VoiceEnrollFinishResult, type VoiceTemplateItem,
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

/** 模板来源的展示标签（与后端 voice_templates.source 取值对应） */
const SOURCE_LABELS: Record<string, string> = {
  reading: "朗读录入",
  auto: "对话自动增量",
};

function formatTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("zh-CN") : "—";
}

function formatSec(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 声纹录入对话框：从花名册成员行的「🎤」按钮打开，给该成员补录声纹
 * （须已完成人脸注册，person_id 直接取自花名册，不依赖实时视频流）。
 *
 * 两段交互：「开始录入」打开设备侧采集并语音提示用户照下面的文本朗读；
 * 用户读完点「完成朗读」由后端评估质量，无论成败本次流程即结束（设备
 * 播报结果，这里同步展示）。质量不合格时是否重试由用户决定——失败结果
 * 页点「重新录入」回到开始页再来一遍，次数不限。
 *
 * 开始页与成功页下方列出该成员正在参与比对的每条声纹模板（来源、入库时间、
 * 净语音时长），每条可回放产生它的录音（朗读录入=那次采集的整段音频，
 * 对话自动增量=那轮的输入语音）、下载、单条删除。
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
  /* 该成员的模板列表：null=还没加载完，此前模板数先用花名册带来的 voiceTemplates */
  const [templates, setTemplates] = useState<VoiceTemplateItem[] | null>(null);
  const templateCount = templates ? templates.length : voiceTemplates;
  /* 已有声纹的删除入口：两步确认（3 秒内再点才执行，与花名册删成员同交互） */
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /* 单条模板删除的两步确认：记住已武装的模板 id */
  const [armedTemplateId, setArmedTemplateId] = useState<number | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const armTimerRef = useRef<number | null>(null);
  const armTemplateTimerRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const loadTemplates = async () => {
    try {
      const r = await fetchVoiceTemplates(personId, deviceSn);
      setTemplates(r.success ? r.items : []);
    } catch {
      /* 列表拉不到不影响录入本身：保留花名册带来的模板数，下次操作后再试 */
    }
  };

  useEffect(() => {
    loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, deviceSn]);

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
        onChanged();
        loadTemplates();
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
      setTemplates([]);
      setNotice(r.message);
      onChanged();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setDeleting(false);
    }
  };

  const armTemplateDelete = (id: number) => {
    setArmedTemplateId(id);
    if (armTemplateTimerRef.current) window.clearTimeout(armTemplateTimerRef.current);
    armTemplateTimerRef.current = window.setTimeout(() => setArmedTemplateId(null), 3000);
  };

  const confirmTemplateDelete = async (id: number) => {
    if (armTemplateTimerRef.current) window.clearTimeout(armTemplateTimerRef.current);
    setArmedTemplateId(null);
    setDeletingTemplateId(id);
    setError(null);
    setNotice(null);
    try {
      const r = await deleteVoiceTemplate(personId, id, deviceSn);
      if (!r.success) {
        setError(r.message);
      } else {
        setNotice(r.message);
        onChanged();
      }
      /* 无论成败按后端现状刷新（template_not_found 说明列表已过期） */
      await loadTemplates();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setDeletingTemplateId(null);
    }
  };

  const reading = phase === "reading" || phase === "checking";
  /* 模板列表在开始页与成功页展示：录完当场就能听刚入库的这条 */
  const showTemplates = phase === "idle" || (phase === "done" && !!result?.success);

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
              {templateCount > 0 && (
                <span className="voice-enroll-existing">
                  已有 {templateCount} 条声纹模板，重新录入会覆盖
                </span>
              )}
              {templateCount > 0 && (deleteArmed ? (
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

          {showTemplates && templates && templates.length > 0 && (
            <div className="voice-template-list">
              <div className="voice-template-list-title">
                🎧 声纹模板（{templates.length} 条，全部参与比对）
              </div>
              {templates.map((t) => (
                <div className="voice-template-card" key={t.id}>
                  <div className="voice-template-head">
                    <span className={`voice-template-source ${t.source ?? "legacy"}`}
                          data-tip={t.source === "auto"
                            ? "对话中视觉确信轮自动增量入库，录音是那轮的输入语音"
                            : t.source === "reading"
                              ? "控制台朗读录入，录音是那次采集的整段音频"
                              : "补列之前入库的旧数据，来源与录音未记录"}>
                      {t.source ? SOURCE_LABELS[t.source] : "旧数据"}
                    </span>
                    <span className="voice-template-time">{formatTime(t.created_at)}</span>
                    <span className="voice-template-dur" data-tip="采集这条模板时的净语音时长">
                      净语音 {t.net_speech_sec.toFixed(1)}s
                    </span>
                    {t.audio_key && (
                      <a className="voice-template-download" href={cosMediaUrl(t.audio_key, true)}
                         data-tip="下载这条模板对应的录音（WAV）">⬇️</a>
                    )}
                    {armedTemplateId === t.id ? (
                      <button className="voice-template-delete confirm"
                              onClick={() => confirmTemplateDelete(t.id)}
                              data-tip="再次点击确认：只删这一条模板，剩余模板照常参与比对；不删录音">
                        确认删除
                      </button>
                    ) : (
                      <button className="voice-template-delete"
                              onClick={() => armTemplateDelete(t.id)}
                              disabled={deletingTemplateId !== null}
                              data-tip="删除这一条模板（如听起来不是本人）">
                        {deletingTemplateId === t.id ? <span className="spinner inline" /> : "🗑️"}
                      </button>
                    )}
                  </div>
                  {t.capture_meta && (
                    <div className="voice-template-meta">
                      <span data-tip="整段采集音频时长（含等待期与停顿静音）">
                        全长 {formatSec(t.capture_meta.duration_ms)}
                      </span>
                      <span data-tip="语音响度（帧 RMS 95 分位，dBFS）">
                        响度 {t.capture_meta.speech_level_db.toFixed(1)}dB
                      </span>
                      <span data-tip="语音响度与底噪之差">
                        信噪比 {t.capture_meta.snr_db.toFixed(1)}dB
                      </span>
                      <span data-tip="录音里实际送去提取向量的区间（裁掉首尾静音，最长 60s）">
                        {t.capture_meta.embed_span_ms
                          ? `送提取 ${formatSec(t.capture_meta.embed_span_ms[0])} – ${formatSec(t.capture_meta.embed_span_ms[1])}`
                          : "送提取 —"}
                      </span>
                    </div>
                  )}
                  {t.audio_key ? (
                    <audio controls preload="none" className="voice-template-player"
                           src={cosMediaUrl(t.audio_key)} />
                  ) : (
                    <div className="voice-template-noaudio">未留档录音</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
