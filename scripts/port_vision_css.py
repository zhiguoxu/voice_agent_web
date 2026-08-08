#!/usr/bin/env python3
"""一次性脚本: 把 person_id/frontend/css/style.css 移植成 web/src/person_id/vision.css。

变换规则:
1. 所有选择器加 .vision-view 前缀 (样式只作用于视觉页签, 不污染控制台)。
2. :root 变量块 → .vision-view (CSS 变量随作用域生效)。
3. html/body 全局规则 → 丢弃 (由手写的 .vision-view 基础块替代)。
4. 原版 ID 选择器 → React 组件里对应的 class。
5. @keyframes 名加 vision- 前缀 (避免与控制台 App.css 的 spin 等重名)。
6. rem → px (×14): 原版 html { font-size: 14px }, 控制台根字号是 16px,
   不换算的话所有 rem 尺寸都会放大 14%。
"""
from __future__ import annotations

import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "person_id/frontend/css/style.css"
DST = Path(__file__).resolve().parents[1] / "src/person_id/vision.css"

ID_MAP = {
    "#app-header": ".vision-header",
    "#app-main": ".vision-main",
    "#video-section": ".video-section",
    "#video-container": ".video-container",
    "#webcam": ".video-container > video",
    "#server-stream-canvas": ".server-stream-canvas",
    "#overlay-canvas": ".overlay-canvas",
    "#no-camera-message": ".no-camera-message",
    "#side-panels": ".side-panels",
    "#pipeline-panel": ".pipeline-panel-root",
    "#controls-panel": ".controls-panel-root",
    "#pipeline-stages": ".pipeline-stages",
    "#threshold-sliders": ".threshold-sliders",
    "#app-footer": ".vision-footer",
    "#events-panel": ".events-panel-root",
    "#gallery-panel": ".gallery-panel-root",
    "#events-timeline": ".events-timeline",
    "#person-gallery": ".person-gallery",
    "#confirm-candidates-section": ".confirm-candidates-section",
    "#confirm-candidates-list": ".confirm-candidates-list",
    "#person-modal": ".person-detail-modal",
    # toast 容器保留 id (Toast.tsx 渲染 id="toast-box")
}

KEYFRAMES = [
    "pulse-dot", "loading-pulse", "spin", "toast-in", "pulse-text",
    "slide-in", "card-settle", "pop-in", "lightbox-fade-in",
]


def rem_to_px(css: str) -> str:
    def conv(m: re.Match) -> str:
        px = float(m.group(1)) * 14
        return f"{px:g}px"
    return re.sub(r"(-?\d*\.?\d+)rem\b", conv, css)


def map_selector(sel: str) -> str | None:
    """单个选择器变换; 返回 None 表示整条规则丢弃。"""
    sel = sel.strip()
    if sel in ("html", "body"):
        return None
    if sel == ":root":
        return ".vision-view"
    for old, new in ID_MAP.items():
        sel = sel.replace(old, new)
    return f".vision-view {sel}"


def transform_rules(body: str) -> str:
    """变换一段顶层规则串 (供全局与 @media 内部复用)。"""
    out: list[str] = []
    i = 0
    n = len(body)
    while i < n:
        # 跳过空白
        if body[i].isspace():
            out.append(body[i])
            i += 1
            continue
        # 注释原样保留
        if body.startswith("/*", i):
            end = body.index("*/", i) + 2
            out.append(body[i:end])
            i = end
            continue
        # 找规则头
        brace = body.index("{", i)
        header = body[i:brace].strip()
        # 找匹配的右括号 (支持嵌套, @media/@keyframes)
        depth = 1
        j = brace + 1
        while depth > 0:
            if body[j] == "{":
                depth += 1
            elif body[j] == "}":
                depth -= 1
            j += 1
        inner = body[brace + 1: j - 1]

        if header.startswith("@keyframes"):
            name = header.split()[1]
            out.append(f"@keyframes vision-{name} {{{inner}}}\n")
        elif header.startswith("@media"):
            out.append(f"{header} {{\n{transform_rules(inner)}}}\n")
        else:
            sels = [map_selector(s) for s in header.split(",")]
            kept = [s for s in sels if s]
            if kept:
                joined = ",\n".join(kept)
                out.append(f"{joined} {{{inner}}}\n")
        i = j
    return "".join(out)


def main() -> None:
    css = SRC.read_text(encoding="utf-8")
    css = rem_to_px(css)
    css = transform_rules(css)
    # keyframes 引用点改名 (原版全部是 "animation: <name> ..." 形态)
    for name in KEYFRAMES:
        css = css.replace(f"animation: {name}", f"animation: vision-{name}")

    header = """\
/* ==============================================================================
 * 视觉识别页签样式 — 由 person_id/frontend/css/style.css 移植
 * (scripts/port_vision_css.py 生成后人工微调, 全部选择器限定在 .vision-view 下)
 *
 * 与原版的差异:
 * - :root 设计变量挂在 .vision-view 上, 不污染控制台全局
 * - 原版 rem 基于 html{font-size:14px}, 控制台根字号 16px, 已换算为 px
 * - @keyframes 加 vision- 前缀, 避免与 App.css 的 spin 等重名
 * - 原版 ID 选择器映射为 React 组件的 class
 * ============================================================================== */

/* --- 页签基础块 (替代原版 html/body 规则): 填满控制台头部以下的剩余空间 --- */
.vision-view {
    box-sizing: border-box;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 14px;
    background: var(--bg-primary);
    color: var(--text-primary);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

/* React 版下拉箭头按条件渲染 (原版用 .hidden): 无箭头时主按钮恢复完整圆角 */
.vision-view .split-btn .split-btn-main:last-child {
    border-top-right-radius: 6px;
    border-bottom-right-radius: 6px;
}

"""
    DST.write_text(header + css, encoding="utf-8")
    print(f"Wrote {DST} ({len(header + css)} bytes)")


if __name__ == "__main__":
    main()
