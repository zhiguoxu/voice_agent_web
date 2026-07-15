import { useState, useEffect, useMemo } from "react";
import type { LogEntry } from "./api";
import "./StackTraceDialog.css";

/* ── Python traceback 文本解析 ──
 * 形如：
 *   Traceback (most recent call last):
 *     File "/path/x.py", line 10, in foo
 *       do_something()
 *       ~~~~~~~~~~~~^^          ← 3.11+ 的定位标记行
 *   ValueError: bad value
 * 链式异常由连接语分隔（During handling... / direct cause...），每段独立解析。
 * 帧顺序为最外层调用 → 抛出点（最后一帧）。
 */

interface Frame {
  file: string;
  line: number;
  func: string;
  code: string[];
}

interface TraceSegment {
  /** 与上一段的链接关系（第一段为空） */
  cause: string | null;
  frames: Frame[];
  /** 段尾的 "ExceptionType: message"，可能多行 */
  excLines: string[];
}

const CAUSE_LABELS: Record<string, string> = {
  "During handling of the above exception, another exception occurred:":
    "处理上述异常时，又引发了下面的异常",
  "The above exception was the direct cause of the following exception:":
    "上述异常直接导致了下面的异常",
};

const FRAME_RE = /^ {2}File "(.+)", line (\d+), in (.+)$/;

function parseTraceback(raw: string): TraceSegment[] | null {
  const segments: TraceSegment[] = [];
  let seg: TraceSegment = { cause: null, frames: [], excLines: [] };
  let frame: Frame | null = null;

  const pushSeg = () => {
    if (seg.frames.length || seg.excLines.length) segments.push(seg);
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed in CAUSE_LABELS) {
      pushSeg();
      seg = { cause: CAUSE_LABELS[trimmed], frames: [], excLines: [] };
      frame = null;
      continue;
    }
    if (trimmed === "Traceback (most recent call last):") continue;

    const m = line.match(FRAME_RE);
    if (m) {
      frame = { file: m[1], line: parseInt(m[2], 10), func: m[3], code: [] };
      seg.frames.push(frame);
      continue;
    }
    // 帧下方缩进 4 空格的行是源码（含 ~~~^^^ 定位标记）
    if (frame && line.startsWith("    ")) {
      frame.code.push(line.slice(4));
      continue;
    }
    frame = null;
    if (trimmed) seg.excLines.push(line);
  }
  pushSeg();

  return segments.some((s) => s.frames.length) ? segments : null;
}

/** 库代码帧（site-packages / 标准库 / 内置），展示时弱化 */
function isLibFrame(f: Frame): boolean {
  return (
    f.file.includes("site-packages") ||
    /\/lib\/python[\d.]+\//.test(f.file) ||
    f.file.startsWith("<")
  );
}

function splitPath(file: string): { dir: string; base: string } {
  const i = file.lastIndexOf("/");
  return i === -1
    ? { dir: "", base: file }
    : { dir: file.slice(0, i + 1), base: file.slice(i + 1) };
}

/** 段尾首行拆出异常类型与消息（"ValueError: bad value"） */
function splitExcTitle(excLines: string[]): { type: string; message: string } {
  const first = excLines[0] ?? "";
  const i = first.indexOf(": ");
  return i === -1
    ? { type: first, message: excLines.slice(1).join("\n") }
    : {
        type: first.slice(0, i),
        message: [first.slice(i + 2), ...excLines.slice(1)].join("\n"),
      };
}

function FrameCard({ frame, index, isLast }: { frame: Frame; index: number; isLast: boolean }) {
  const lib = isLibFrame(frame);
  const { dir, base } = splitPath(frame.file);
  return (
    <div className={`stack-frame ${lib ? "lib" : ""} ${isLast ? "raise-site" : ""}`}>
      <span className="stack-frame-index">{index + 1}</span>
      <div className="stack-frame-main">
        <div className="stack-frame-loc">
          <span className="stack-frame-dir" data-tip={frame.file}>{dir}</span>
          <span className="stack-frame-file">{base}:{frame.line}</span>
          <span className="stack-frame-func">{frame.func}</span>
          {lib && <span className="stack-tag lib-tag">库</span>}
          {isLast && <span className="stack-tag raise-tag">抛出点</span>}
        </div>
        {frame.code.length > 0 && (
          <pre className="stack-frame-code">
            {frame.code.map((c, i) => (
              <div key={i} className={/^[\s~^]+$/.test(c) ? "code-anchor" : undefined}>
                {c}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

export function StackTraceDialog({ entry, onClose }: { entry: LogEntry; onClose: () => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const raw = entry.exc ?? "";
  const segments = useMemo(() => parseTraceback(raw), [raw]);
  // Python 链式异常最后一段才是实际抛出的异常，标题取它
  const title = splitExcTitle(segments?.[segments.length - 1]?.excLines ?? [raw]);

  const copyRaw = () => {
    navigator.clipboard
      .writeText(raw)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="roster-dialog-overlay" onClick={onClose}>
      <div className="roster-dialog stack-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>
          ⚠️ 异常堆栈
          <span className="subtitle">
            {entry.time} · {entry.source || "-"} · {entry.name}:{entry.function}:{entry.line}
            {entry.trace_id && ` · ${entry.trace_id}`}
          </span>
          <button
            className={`stack-toggle-btn ${showRaw ? "active" : ""}`}
            onClick={() => setShowRaw((v) => !v)}
            disabled={!segments}
            data-tip={segments ? "在解析视图与原始文本间切换" : "解析失败，仅原始文本"}
          >
            {showRaw ? "解析视图" : "原始文本"}
          </button>
          <button className="stack-toggle-btn" onClick={copyRaw}>
            {copied ? "✓ 已复制" : "📋 复制"}
          </button>
          <button className="roster-close" onClick={onClose} data-tip="关闭 (Esc)">×</button>
        </h3>

        <div className="roster-dialog-body">
          {/* 异常概要：类型 + 消息醒目展示 */}
          <div className="stack-summary">
            <span className="stack-exc-type">{title.type || "Exception"}</span>
            {title.message && <span className="stack-exc-msg">{title.message}</span>}
          </div>
          <div className="stack-log-msg" data-tip="触发这条日志的消息">{entry.msg}</div>

          {!segments || showRaw ? (
            <pre className="stack-raw">{raw}</pre>
          ) : (
            segments.map((seg, si) => (
              <div key={si} className="stack-segment">
                {seg.cause && <div className="stack-cause">↓ {seg.cause}</div>}
                <div className="stack-frames">
                  {seg.frames.map((f, fi) => (
                    <FrameCard
                      key={fi}
                      frame={f}
                      index={fi}
                      isLast={fi === seg.frames.length - 1}
                    />
                  ))}
                </div>
                {/* 非最后一段的异常行跟在帧后（最后一段的已在顶部概要展示） */}
                {si < segments.length - 1 && seg.excLines.length > 0 && (
                  <div className="stack-seg-exc">{seg.excLines.join("\n")}</div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
