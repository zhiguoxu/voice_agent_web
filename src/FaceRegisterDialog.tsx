import { useEffect, useRef, useState } from "react";
import { cancelFaceRegister, registerFace, type FaceRegisterResult } from "./api";
import "./RosterDialog.css";
import "./FaceRegisterDialog.css";

/**
 * 注册人脸对话框：输入人名后触发一次引导式人脸注册。
 *
 * 触发接口是同步的：请求会阻塞到整个注册流程结束（最多 3 轮 × 每轮 4 次
 * 带质量门槛的注册探测，通常几十秒），期间设备语音引导用户注视 mini 头部；
 * 这里展示等待态与最终结果（成功时含 person_id）。注册进行中关闭对话框
 * 要显式调 cancel——只丢掉这条请求后端不会停，设备会继续语音引导。
 */
export function FaceRegisterDialog({ deviceSn, onClose }: {
  deviceSn: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<FaceRegisterResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  /* 注册进行中关闭对话框（含 Esc）要顺手取消后端流程，设备播报"已取消"收场 */
  const close = () => {
    if (submittingRef.current) {
      cancelFaceRegister(deviceSn).catch(() => {});
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

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      // ISS 环境与拉流控制对话框同一份选择（未拉流时后端自动开流用）
      const env = localStorage.getItem("streamIssEnv") || "test";
      setResult(await registerFace(deviceSn, trimmed, env));
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="roster-dialog-overlay" onClick={close}>
      <div className="roster-dialog face-register-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>
          📷 注册人脸
          <span className="subtitle">设备 {deviceSn}</span>
          <button className="roster-close" onClick={close} data-tip="关闭 (Esc)">×</button>
        </h3>

        <div className="roster-dialog-body">
          <p className="face-register-hint">
            输入要注册的人名后开始。摄像头未在拉流时会自动开启（多等约十几秒）；
            注册过程由设备语音引导（请让用户注视 mini 头部，每轮约 8 秒、最多
            3 轮，按更高的人脸质量标准采集底片），本页面会一直等到流程结束并
            展示结果；中途关闭本页面会取消注册。
          </p>
          <div className="face-register-form">
            <input
              className="roster-input"
              placeholder="要注册的人名，如：张三"
              value={name}
              autoFocus
              disabled={submitting}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
            <button
              className="roster-save-btn"
              disabled={submitting || !name.trim()}
              onClick={submit}
            >
              {submitting ? <span className="spinner inline" /> : "开始注册"}
            </button>
          </div>
          {submitting && (
            <div className="face-register-result running">
              ⏳ 注册进行中（典型几十秒，最长约两分钟，未拉流会先自动开启摄像头）……请让用户按设备语音提示注视 mini 头部
            </div>
          )}
          {result && (
            <div className={`face-register-result ${result.success ? "ok" : "fail"}`}>
              {result.success ? "✅" : "❌"} {result.message}
              {result.person_id && (
                <div className="face-register-pid">person_id: {result.person_id}</div>
              )}
            </div>
          )}
          {error && (
            <div className="face-register-result fail">❌ {error}</div>
          )}
        </div>
      </div>
    </div>
  );
}
