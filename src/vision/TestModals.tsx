/**
 * 调试测试弹窗三件套（从 person_id/frontend/js/test-*.js 移植）：
 *   - TestBodyQualityModal   全身质量评分（POST /api/test_body_quality）
 *   - FaceSimilarityModal    人脸相似度（POST /api/test_face_similarity）
 *   - BodySimilarityModal    全身 ReID 对比 SOLIDER vs OSNet（POST /api/test_reid_compare）
 *
 * 三个弹窗共享同一套「选图 → 预览 + bbox 叠加 → 出分」交互，
 * 预览图上的框线用绝对定位 canvas 按 object-fit: contain 的缩放规则绘制。
 */
import { useEffect, useRef, useState } from "react";
import { testBodyQuality, testFaceSimilarity, testReidCompare } from "./api";
import type {
  BodyQualityResult,
  BodySimInfo,
  BodySimResult,
  FaceSimInfo,
  FaceSimResult,
} from "./types";

/* ════════════════════════ 共享小部件 ════════════════════════ */

interface OverlayBox {
  bbox: number[];
  color: string;
  dash?: number[];
  label?: string;
}

/** 在预览 canvas 上按显示缩放画框（图片可能还没加载完，轮询到 naturalWidth 可用为止） */
function drawOverlayBoxes(
  imgEl: HTMLImageElement | null,
  canvasEl: HTMLCanvasElement | null,
  boxes: OverlayBox[],
) {
  if (!imgEl || !canvasEl) return;
  const tryDraw = () => {
    if (!imgEl.isConnected) return;
    if (!imgEl.naturalWidth) {
      setTimeout(tryDraw, 50);
      return;
    }
    const imgW = imgEl.naturalWidth;
    const imgH = imgEl.naturalHeight;
    const displayW = imgEl.offsetWidth;
    const displayH = imgEl.offsetHeight;
    if (!displayW || !displayH) return;

    canvasEl.width = displayW;
    canvasEl.height = displayH;

    const scale = Math.min(displayW / imgW, displayH / imgH);
    const offsetX = (displayW - imgW * scale) / 2;
    const offsetY = (displayH - imgH * scale) / 2;

    const ctx = canvasEl.getContext("2d")!;
    ctx.clearRect(0, 0, displayW, displayH);
    for (const box of boxes) {
      const [x1, y1, x2, y2] = box.bbox;
      ctx.strokeStyle = box.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(box.dash || []);
      ctx.strokeRect(
        x1 * scale + offsetX, y1 * scale + offsetY,
        (x2 - x1) * scale, (y2 - y1) * scale,
      );
      if (box.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = box.color;
        ctx.font = "11px Inter, sans-serif";
        ctx.fillText(box.label, x1 * scale + offsetX + 3, y1 * scale + offsetY - 4);
      }
    }
  };
  tryDraw();
}

function clearCanvas(canvasEl: HTMLCanvasElement | null) {
  if (canvasEl?.width) {
    canvasEl.getContext("2d")!.clearRect(0, 0, canvasEl.width, canvasEl.height);
  }
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function useEscToClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** 单列上传器：选图按钮 + 文件名 + 预览（img + bbox canvas）+ 底部信息区 */
function SimUploadCol({ label, inputId, previewSrc, onPick, imgRef, canvasRef, info }: {
  label: string;
  inputId: string;
  previewSrc: string | null;
  onPick: (file: File | null) => void;
  imgRef: React.RefObject<HTMLImageElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  info: React.ReactNode;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  return (
    <div className="face-sim-upload-col">
      <div className="face-sim-col-header">{label}</div>
      <div className="form-group">
        <label htmlFor={inputId} className="btn btn-primary btn-xs" style={{ cursor: "pointer" }}>
          📸 Choose
        </label>
        <input
          type="file"
          id={inputId}
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0] || null;
            setFileName(file?.name || null);
            onPick(file);
          }}
        />
        <span className="face-sim-filename">{fileName || "No file selected"}</span>
      </div>
      {previewSrc && (
        <div className="face-sim-preview-container">
          <img ref={imgRef} className="face-sim-preview-img" src={previewSrc} alt={label} />
          <canvas ref={canvasRef} className="face-sim-preview-canvas" />
        </div>
      )}
      {info != null && <div className="face-sim-info">{info}</div>}
    </div>
  );
}

/** 相似度仪表：分值 + 量程条 + 解读文案 */
function SimGauge({ label, value, pct, barColor, interp, interpColor, valueFontSize }: {
  label: string;
  value: number;
  /** 量程条填充百分比 0~100 */
  pct: number;
  barColor: string;
  interp: string;
  interpColor: string;
  valueFontSize?: number;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ flex: 1, minWidth: 280 }}>
      <div className="face-sim-score-label">{label}</div>
      <div
        className="face-sim-score-value"
        style={{ color: barColor, ...(valueFontSize ? { fontSize: valueFontSize } : {}) }}
      >
        {value.toFixed(4)}
      </div>
      <div className="face-sim-gauge-track">
        <div className="face-sim-gauge-fill" style={{ width: `${clamped}%`, background: barColor }} />
        <div className="face-sim-gauge-marker" style={{ left: `${clamped}%` }} />
      </div>
      <div className="face-sim-gauge-labels">
        <span>0.0</span><span>0.5</span><span>1.0</span>
      </div>
      <div className="face-sim-interp" style={{ color: interpColor }}>{interp}</div>
    </div>
  );
}

/* ════════════════════════ Test Body Quality ════════════════════════ */

export function TestBodyQualityModal({ onClose }: { onClose: () => void }) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "done"; data: BodyQualityResult }
  >({ phase: "idle" });
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEscToClose(onClose);

  const handlePick = async (file: File | null) => {
    setFileName(file?.name || null);
    if (!file) {
      setPreviewSrc(null);
      setState({ phase: "idle" });
      return;
    }
    setState({ phase: "loading" });
    clearCanvas(canvasRef.current);
    setPreviewSrc(await readAsDataURL(file));
    try {
      const data = await testBodyQuality(file);
      if (data.error) {
        setState({ phase: "error", message: `Error: ${data.error}` });
        return;
      }
      setState({ phase: "done", data });
      if (data.bbox) {
        drawOverlayBoxes(imgRef.current, canvasRef.current, [
          { bbox: data.bbox, color: "#76ff03" },
        ]);
      }
    } catch (e: unknown) {
      setState({
        phase: "error",
        message: `Failed to connect to API: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  return (
    <div className="modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-content" style={{ maxWidth: 600 }}>
        <div className="modal-header">
          <h3>Test Body Quality</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label
              htmlFor="vision-test-quality-file"
              className="btn btn-primary"
              style={{ display: "inline-block", cursor: "pointer" }}
            >
              📸 Choose Image
            </label>
            <input
              type="file"
              id="vision-test-quality-file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => void handlePick(e.target.files?.[0] || null)}
            />
            <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-muted)" }}>
              {fileName || "No file selected"}
            </span>
          </div>

          {previewSrc && (
            <div
              style={{
                marginTop: 15, position: "relative", textAlign: "center",
                background: "var(--bg-surface)", padding: 10, borderRadius: 8,
                border: "1px solid var(--border-color)",
              }}
            >
              <img
                ref={imgRef}
                src={previewSrc}
                alt="preview"
                style={{ maxWidth: "100%", maxHeight: 400, borderRadius: 4 }}
              />
              <canvas
                ref={canvasRef}
                style={{
                  position: "absolute", top: 10, left: "50%",
                  transform: "translateX(-50%)", pointerEvents: "none",
                }}
              />
            </div>
          )}

          {state.phase !== "idle" && (
            <div
              style={{
                marginTop: 15, padding: 15, background: "var(--bg-panel)",
                borderRadius: 8, border: "1px solid var(--border-color)",
              }}
            >
              {state.phase === "loading" ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)" }}>Testing...</div>
              ) : state.phase === "error" ? (
                <div style={{ color: "var(--accent-red)" }}>{state.message}</div>
              ) : !state.data.has_person ? (
                <div style={{ color: "var(--accent-orange)" }}>No person detected in the image.</div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <QualityCell label="Final Quality" big value={state.data.quality!.toFixed(3)} />
                  <QualityCell label="Formula" value="0.75 * Hint + 0.25 * Sharpness" small />
                  <QualityCell label="Quality Hint" value={state.data.quality_hint!.toFixed(3)} />
                  <QualityCell label="Sharpness" value={state.data.sharpness!.toFixed(3)} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function QualityCell({ label, value, big, small }: {
  label: string; value: string; big?: boolean; small?: boolean;
}) {
  return (
    <div style={{ background: "var(--bg-surface)", padding: 10, borderRadius: 6 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>
      <div
        style={
          big
            ? { fontSize: 20, fontWeight: "bold", color: "var(--accent-blue)" }
            : small
              ? { fontSize: 13, marginTop: 4 }
              : { fontSize: 16, fontWeight: 500 }
        }
      >
        {value}
      </div>
    </div>
  );
}

/* ════════════════════════ Face Similarity ════════════════════════ */

export function FaceSimilarityModal({ onClose }: { onClose: () => void }) {
  const [undistort, setUndistort] = useState(false);
  const [preview1, setPreview1] = useState<string | null>(null);
  const [preview2, setPreview2] = useState<string | null>(null);
  const [result, setResult] = useState<
    | null
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "done"; data: FaceSimResult }
  >(null);
  const filesRef = useRef<{ f1: File | null; f2: File | null }>({ f1: null, f2: null });
  const img1Ref = useRef<HTMLImageElement | null>(null);
  const canvas1Ref = useRef<HTMLCanvasElement | null>(null);
  const img2Ref = useRef<HTMLImageElement | null>(null);
  const canvas2Ref = useRef<HTMLCanvasElement | null>(null);

  useEscToClose(onClose);

  const drawFaceBoxes = (
    info: FaceSimInfo | undefined,
    img: HTMLImageElement | null,
    canvas: HTMLCanvasElement | null,
  ) => {
    if (!info?.has_face) return;
    const boxes: OverlayBox[] = [];
    if (info.person_bbox) {
      boxes.push({ bbox: info.person_bbox, color: "#76ff03", dash: [6, 3], label: "Person" });
    }
    if (info.face_bbox) {
      boxes.push({ bbox: info.face_bbox, color: "#00e5ff", label: "Face" });
    }
    drawOverlayBoxes(img, canvas, boxes);
  };

  const tryCompare = async (withUndistort: boolean) => {
    const { f1, f2 } = filesRef.current;
    if (!f1 || !f2) return;
    setResult({ phase: "loading" });
    clearCanvas(canvas1Ref.current);
    clearCanvas(canvas2Ref.current);
    try {
      const data = await testFaceSimilarity(f1, f2, withUndistort);
      if (data.error) {
        setResult({ phase: "error", message: `Error: ${data.error}` });
        return;
      }
      // 有畸变矫正图则替换预览
      if (data.corrected_image1_b64) setPreview1(`data:image/jpeg;base64,${data.corrected_image1_b64}`);
      if (data.corrected_image2_b64) setPreview2(`data:image/jpeg;base64,${data.corrected_image2_b64}`);
      setResult({ phase: "done", data });
      drawFaceBoxes(data.face1, img1Ref.current, canvas1Ref.current);
      drawFaceBoxes(data.face2, img2Ref.current, canvas2Ref.current);
    } catch (e: unknown) {
      setResult({
        phase: "error",
        message: `Failed to connect to API: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const pick = (slot: "f1" | "f2") => async (file: File | null) => {
    filesRef.current[slot] = file;
    const setPreview = slot === "f1" ? setPreview1 : setPreview2;
    setPreview(file ? await readAsDataURL(file) : null);
    void tryCompare(undistort);
  };

  const data = result?.phase === "done" ? result.data : null;

  return (
    <div className="modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-content" style={{ maxWidth: 820 }}>
        <div className="modal-header">
          <h3>🔍 Face Similarity Test</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <UndistortCheckbox
            id="vision-face-sim-undistort"
            checked={undistort}
            onChange={(v) => { setUndistort(v); void tryCompare(v); }}
          />
          <div className="face-sim-upload-row">
            <SimUploadCol
              label="Image 1" inputId="vision-face-sim-file1" previewSrc={preview1}
              onPick={pick("f1")} imgRef={img1Ref} canvasRef={canvas1Ref}
              info={data ? <FaceInfo info={data.face1} label="Image 1" /> : null}
            />
            <SimUploadCol
              label="Image 2" inputId="vision-face-sim-file2" previewSrc={preview2}
              onPick={pick("f2")} imgRef={img2Ref} canvasRef={canvas2Ref}
              info={data ? <FaceInfo info={data.face2} label="Image 2" /> : null}
            />
          </div>

          {result && (
            <div
              style={{
                marginTop: 15, padding: 15, background: "var(--bg-panel)",
                borderRadius: 8, border: "1px solid var(--border-glass)",
              }}
            >
              {result.phase === "loading" ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)", padding: 20 }}>
                  <div className="face-sim-spinner" />Analyzing faces...
                </div>
              ) : result.phase === "error" ? (
                <div style={{ color: "var(--accent-red)", textAlign: "center", padding: 15 }}>
                  {result.message}
                </div>
              ) : (
                <FaceSimScore data={result.data} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UndistortCheckbox({ id, checked, onChange }: {
  id: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
      <label
        htmlFor={id}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" }}
        title="对上传图片做镜头畸变矫正后再计算相似度"
      >
        <input type="checkbox" id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>📐 畸变矫正 (Undistort)</span>
      </label>
    </div>
  );
}

function FaceInfo({ info, label }: { info: FaceSimInfo | undefined; label: string }) {
  if (!info?.has_face) {
    return (
      <div style={{ color: "var(--accent-orange)", fontSize: 13 }}>
        ⚠️ No face detected in {label}
      </div>
    );
  }
  const q = info.face_quality;
  const qColor = q == null ? undefined
    : q >= 0.5 ? "var(--accent-green)"
      : q >= 0.3 ? "var(--accent-orange)" : "var(--accent-red)";
  return (
    <div className="face-sim-face-info">
      {info.aligned_face_b64 && (
        <img
          className="face-sim-aligned-thumb"
          src={`data:image/jpeg;base64,${info.aligned_face_b64}`}
          title="Aligned 112×112 face"
          alt="aligned face"
        />
      )}
      {q != null && (
        <div className="face-sim-quality">
          Quality: <span style={{ color: qColor, fontWeight: 600 }}>{q.toFixed(4)}</span>
        </div>
      )}
    </div>
  );
}

function FaceSimScore({ data }: { data: FaceSimResult }) {
  if (!data.face1?.has_face || !data.face2?.has_face) {
    const msg = !data.face1?.has_face && !data.face2?.has_face
      ? "No face detected in either image."
      : !data.face1?.has_face
        ? "No face detected in Image 1."
        : "No face detected in Image 2.";
    return (
      <div style={{ color: "var(--accent-orange)", textAlign: "center", padding: 20, fontSize: 14 }}>
        ⚠️ {msg}
      </div>
    );
  }

  const sim = data.similarity!;
  const pct = Math.max(0, Math.min(100, ((sim + 1) / 2) * 100));

  let interp: string, interpColor: string;
  if (sim >= 0.5) { interp = "✅ Very High — Very likely the same person"; interpColor = "var(--accent-green)"; }
  else if (sim >= 0.4) { interp = "🟢 High — Likely the same person"; interpColor = "var(--accent-green)"; }
  else if (sim >= 0.3) { interp = "🟡 Medium — Possibly the same person"; interpColor = "var(--accent-orange)"; }
  else if (sim >= 0.2) { interp = "🟠 Low — Unlikely the same person"; interpColor = "var(--accent-orange)"; }
  else { interp = "🔴 Very Low — Different persons"; interpColor = "var(--accent-red)"; }

  const barColor = sim >= 0.4 ? "var(--accent-green)"
    : sim >= 0.25 ? "var(--accent-orange)" : "var(--accent-red)";

  const fmt = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(4));

  return (
    <div className="face-sim-score-panel">
      <div className="face-sim-score-label">Face Similarity Score (Cosine)</div>
      <div className="face-sim-score-value" style={{ color: barColor }}>{sim.toFixed(4)}</div>
      <div className="face-sim-gauge-track">
        <div className="face-sim-gauge-fill" style={{ width: `${pct}%`, background: barColor }} />
        <div className="face-sim-gauge-marker" style={{ left: `${pct}%` }} />
      </div>
      <div className="face-sim-gauge-labels">
        <span>-1.0</span><span>0.0</span><span>+1.0</span>
      </div>
      <div className="face-sim-interp" style={{ color: interpColor }}>{interp}</div>
      {(data.similarity_bgr != null || data.similarity_rgb != null) && (
        <div className="face-sim-channels">
          <span className="face-sim-channel">BGR channel: <strong>{fmt(data.similarity_bgr)}</strong></span>
          <span className="face-sim-channel">RGB channel: <strong>{fmt(data.similarity_rgb)}</strong></span>
        </div>
      )}
      <div className="face-sim-thresholds">
        <span>System thresholds — Definite: ≥0.85 | Confident: ≥0.72 | Suspected: ≥0.55</span>
      </div>
    </div>
  );
}

/* ════════════════════════ Body ReID Compare ════════════════════════ */

export function BodySimilarityModal({ onClose }: { onClose: () => void }) {
  const [undistort, setUndistort] = useState(false);
  const [preview1, setPreview1] = useState<string | null>(null);
  const [preview2, setPreview2] = useState<string | null>(null);
  const [result, setResult] = useState<
    | null
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "done"; data: BodySimResult }
  >(null);
  const filesRef = useRef<{ f1: File | null; f2: File | null }>({ f1: null, f2: null });
  const img1Ref = useRef<HTMLImageElement | null>(null);
  const canvas1Ref = useRef<HTMLCanvasElement | null>(null);
  const img2Ref = useRef<HTMLImageElement | null>(null);
  const canvas2Ref = useRef<HTMLCanvasElement | null>(null);

  useEscToClose(onClose);

  const drawBodyBox = (
    info: BodySimInfo | undefined,
    img: HTMLImageElement | null,
    canvas: HTMLCanvasElement | null,
  ) => {
    if (!info?.has_body || !info.person_bbox) return;
    drawOverlayBoxes(img, canvas, [
      { bbox: info.person_bbox, color: "#76ff03", dash: [6, 3], label: "Person" },
    ]);
  };

  const tryCompare = async (withUndistort: boolean) => {
    const { f1, f2 } = filesRef.current;
    if (!f1 || !f2) return;
    setResult({ phase: "loading" });
    clearCanvas(canvas1Ref.current);
    clearCanvas(canvas2Ref.current);
    try {
      const data = await testReidCompare(f1, f2, withUndistort);
      if (data.error) {
        setResult({ phase: "error", message: `Error: ${data.error}` });
        return;
      }
      if (data.corrected_image1_b64) setPreview1(`data:image/jpeg;base64,${data.corrected_image1_b64}`);
      if (data.corrected_image2_b64) setPreview2(`data:image/jpeg;base64,${data.corrected_image2_b64}`);
      setResult({ phase: "done", data });
      drawBodyBox(data.body1, img1Ref.current, canvas1Ref.current);
      drawBodyBox(data.body2, img2Ref.current, canvas2Ref.current);
    } catch (e: unknown) {
      setResult({
        phase: "error",
        message: `Failed to connect to API: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const pick = (slot: "f1" | "f2") => async (file: File | null) => {
    filesRef.current[slot] = file;
    const setPreview = slot === "f1" ? setPreview1 : setPreview2;
    setPreview(file ? await readAsDataURL(file) : null);
    void tryCompare(undistort);
  };

  const data = result?.phase === "done" ? result.data : null;

  return (
    <div className="modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-content" style={{ maxWidth: 820 }}>
        <div className="modal-header">
          <h3>🧍 Body ReID Compare (SOLIDER vs OSNet)</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <UndistortCheckbox
            id="vision-body-sim-undistort"
            checked={undistort}
            onChange={(v) => { setUndistort(v); void tryCompare(v); }}
          />
          <div className="face-sim-upload-row">
            <SimUploadCol
              label="Image 1" inputId="vision-body-sim-file1" previewSrc={preview1}
              onPick={pick("f1")} imgRef={img1Ref} canvasRef={canvas1Ref}
              info={data ? <BodyInfo info={data.body1} label="Image 1" /> : null}
            />
            <SimUploadCol
              label="Image 2" inputId="vision-body-sim-file2" previewSrc={preview2}
              onPick={pick("f2")} imgRef={img2Ref} canvasRef={canvas2Ref}
              info={data ? <BodyInfo info={data.body2} label="Image 2" /> : null}
            />
          </div>

          {result && (
            <div
              style={{
                marginTop: 15, padding: 15, background: "var(--bg-panel)",
                borderRadius: 8, border: "1px solid var(--border-glass)",
              }}
            >
              {result.phase === "loading" ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)", padding: 20 }}>
                  <div className="face-sim-spinner" />Analyzing body features (SOLIDER + OSNet)...
                </div>
              ) : result.phase === "error" ? (
                <div style={{ color: "var(--accent-red)", textAlign: "center", padding: 15 }}>
                  {result.message}
                </div>
              ) : (
                <BodySimScore data={result.data} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BodyInfo({ info, label }: { info: BodySimInfo | undefined; label: string }) {
  if (!info?.has_body) {
    return (
      <div style={{ color: "var(--accent-orange)", fontSize: 13 }}>
        ⚠️ No person detected in {label}
      </div>
    );
  }
  return (
    <div className="body-sim-body-info">
      {info.body_crop_b64 && (
        <img
          className="body-sim-crop-thumb"
          src={`data:image/jpeg;base64,${info.body_crop_b64}`}
          title="Body crop 128×384"
          alt="body crop"
        />
      )}
      <div className="body-sim-label">✅ Person detected</div>
    </div>
  );
}

function bodyInterp(sim: number): { text: string; color: string } {
  if (sim >= 0.85) return { text: "✅ Very High — Same person", color: "var(--accent-green)" };
  if (sim >= 0.70) return { text: "🟢 High — Very likely same", color: "var(--accent-green)" };
  if (sim >= 0.50) return { text: "🟡 Medium — Possibly same", color: "var(--accent-orange)" };
  if (sim >= 0.30) return { text: "🟠 Low — Unlikely same", color: "var(--accent-orange)" };
  return { text: "🔴 Very Low — Different", color: "var(--accent-red)" };
}

function bodyBarColor(sim: number): string {
  if (sim >= 0.70) return "var(--accent-green)";
  if (sim >= 0.40) return "var(--accent-orange)";
  return "var(--accent-red)";
}

function BodySimScore({ data }: { data: BodySimResult }) {
  if (!data.body1?.has_body || !data.body2?.has_body) {
    const msg = !data.body1?.has_body && !data.body2?.has_body
      ? "No person detected in either image."
      : !data.body1?.has_body
        ? "No person detected in Image 1."
        : "No person detected in Image 2.";
    return (
      <div style={{ color: "var(--accent-orange)", textAlign: "center", padding: 20, fontSize: 14 }}>
        ⚠️ {msg}
      </div>
    );
  }

  const solider = data.solider_similarity;
  const osnet = data.osnet_similarity;

  return (
    <>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        {solider != null && (
          <SimGauge
            label={`🔷 SOLIDER Swin-Small (${data.solider_dim || 768}D)`}
            value={solider} pct={solider * 100}
            barColor={bodyBarColor(solider)}
            interp={bodyInterp(solider).text} interpColor={bodyInterp(solider).color}
            valueFontSize={28}
          />
        )}
        {osnet != null && (
          <SimGauge
            label={`🔶 OSNet-AIN x1.0 (${data.osnet_dim || 512}D)`}
            value={osnet} pct={osnet * 100}
            barColor={bodyBarColor(osnet)}
            interp={bodyInterp(osnet).text} interpColor={bodyInterp(osnet).color}
            valueFontSize={28}
          />
        )}
      </div>
      {solider != null && osnet != null && (
        <div
          style={{
            marginTop: 15, padding: 10, background: "rgba(255,255,255,0.03)",
            borderRadius: 6, textAlign: "center", fontSize: 13, color: "var(--text-muted)",
          }}
        >
          Δ = {Math.abs(solider - osnet).toFixed(4)}{" "}
          ({solider > osnet ? "SOLIDER higher" : solider < osnet ? "OSNet higher" : "Equal"})
        </div>
      )}
    </>
  );
}
