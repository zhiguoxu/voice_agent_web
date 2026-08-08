/**
 * 图片灯箱：大图预览 + 下载（从 person_id/frontend/js/image-lightbox.js 移植）。
 *
 * 原版用全局事件委托拦截所有 <img> 点击；React 版改为显式调用
 * openLightbox()（经 VisionContext 下发），带 bbox 时在预览上叠加框线，
 * 下载始终为原图（不含框线）。
 */
import { useEffect, useRef } from "react";

export interface LightboxState {
  src: string;
  bbox?: number[] | null;
  color?: string;
}

export function ImageLightbox({ state, onClose }: {
  state: LightboxState;
  onClose: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const drawOverlayBbox = () => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !state.bbox) return;

    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    const displayW = img.offsetWidth;
    const displayH = img.offsetHeight;
    if (!displayW || !displayH) return;

    canvas.width = displayW;
    canvas.height = displayH;
    canvas.style.display = "block";

    // object-fit: contain 缩放计算
    const scale = Math.min(displayW / imgW, displayH / imgH);
    const renderedW = imgW * scale;
    const renderedH = imgH * scale;
    const offsetX = (displayW - renderedW) / 2;
    const offsetY = (displayH - renderedH) / 2;

    const [x1, y1, x2, y2] = state.bbox;
    const color = state.color || "#00e5ff";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, displayW, displayH);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.strokeRect(
      x1 * scale + offsetX, y1 * scale + offsetY,
      (x2 - x1) * scale, (y2 - y1) * scale,
    );
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  return (
    <div className="lightbox-overlay">
      <div className="lightbox-backdrop" onClick={onClose} />
      <div className="lightbox-body">
        <div className="lightbox-img-container">
          <img
            ref={imgRef}
            className="lightbox-img"
            alt="Preview"
            src={state.src}
            onLoad={state.bbox ? drawOverlayBbox : undefined}
          />
          <canvas
            ref={canvasRef}
            className="lightbox-canvas"
            style={{ display: "none" }}
          />
        </div>
        <div className="lightbox-toolbar">
          <a
            className="lightbox-btn lightbox-download"
            title="Download"
            href={state.src}
            download={`vision-id-${ts}.jpg`}
          >
            ⬇ Download
          </a>
          <button className="lightbox-btn lightbox-close" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
