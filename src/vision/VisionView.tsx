/**
 * 视觉识别仪表盘主视图（person_id/frontend 的 React 重写版）。
 *
 * 装配关系：
 * - VisionSocket / VideoCapture / StreamViewer / OverlayRenderer 四个命令式
 *   控制器在挂载时创建，视频帧与画框全程绕过 React；
 * - 帧结果经 VisionBus 广播，Pipeline / 事件时间线 / 花名册各自订阅局部刷新；
 * - 切换设备 SN 时通过 key 重建整个仪表盘（对应原版的整页刷新语义）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchConsumeStatus,
  fetchVisionConfig,
  startConsume,
  startDeviceStream,
  stopConsume,
  stopDeviceStream,
  updateVisionConfig,
  visionWsUrl,
} from "./api";
import { VisionBus } from "./bus";
import { ConfirmIdentityModal } from "./ConfirmIdentityModal";
import { VisionContext, type ToastType, type VisionContextValue } from "./context";
import { ControlsPanel } from "./ControlsPanel";
import { OverlayRenderer, type OverlayOptions } from "./core/OverlayRenderer";
import { StreamViewer } from "./core/StreamViewer";
import { VideoCapture } from "./core/VideoCapture";
import { VisionSocket } from "./core/VisionSocket";
import { EventsTimeline } from "./EventsTimeline";
import { ImageLightbox, type LightboxState } from "./ImageLightbox";
import { PersonGallery } from "./PersonGallery";
import { PipelinePanel } from "./PipelinePanel";
import { RestreamLogModal } from "./RestreamLogModal";
import { BodySimilarityModal, FaceSimilarityModal, TestBodyQualityModal } from "./TestModals";
import { ToastContainer } from "./Toast";
import { useToasts } from "./useToasts";
import type {
  ConsumeStatus,
  QualityThresholds,
  RawTrackedPerson,
  TrackedPerson,
  TunableParams,
} from "./types";
import "./vision.css";

type IssEnv = "test" | "prod";
type TestModalKind = "quality" | "face" | "body";

/** frame_result 中嵌套的 TrackedPersonResponse 展平（与原 app.js 一致） */
function flattenPersons(raw: RawTrackedPerson[]): TrackedPerson[] {
  return raw.map((p) => {
    if (p.person && p.identity_result) {
      return {
        track_id: p.person.track_id,
        bbox: p.person.detection?.bbox,
        keypoints: p.person.detection?.keypoints,
        pose_bucket: p.person.detection?.pose_bucket,
        attention_score: p.person.attention_score,
        trail: p.person.trail,
        person_id: p.identity_result.person_id,
        display_name: p.identity_result.display_name,
        identity_status: p.identity_result.status,
        confidence: p.identity_result.confidence,
        face_quality: p.identity_result.face_quality,
        is_current_target: p.is_current_target,
      };
    }
    return p;
  });
}

/** FPS / 延迟角标（独占订阅 socket.onStats，帧级刷新只重渲染本组件） */
function StatsBadges({ socket }: { socket: VisionSocket }) {
  const [fps, setFps] = useState(0);
  const [latency, setLatency] = useState(0);
  useEffect(() => {
    socket.onStats = (f, l) => {
      setFps(Math.round(f));
      setLatency(Math.round(l));
    };
    return () => { socket.onStats = null; };
  }, [socket]);
  return (
    <>
      <div className="status-badge">
        <span className="fps-value">{fps}</span>
        <span className="fps-label">FPS</span>
      </div>
      <div className="status-badge">
        <span className="latency-value">{latency}</span>
        <span className="latency-label">ms</span>
      </div>
    </>
  );
}

function VisionDashboard({ cameraId, onCameraIdChange }: {
  cameraId: string;
  onCameraIdChange: (sn: string) => void;
}) {
  /* ── 命令式控制器（挂载期单例） ── */
  const videoRef = useRef<HTMLVideoElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const snInputRef = useRef<HTMLInputElement>(null);
  const streamUrlInputRef = useRef<HTMLInputElement>(null);

  const core = useMemo(() => {
    const bus = new VisionBus();
    const socket = new VisionSocket(() => visionWsUrl(cameraId));
    const viewer = new StreamViewer(
      () => serverCanvasRef.current,
      () => containerRef.current,
    );
    const capture = new VideoCapture(
      () => videoRef.current,
      () => containerRef.current,
      socket,
    );
    const overlay = new OverlayRenderer(
      () => overlayCanvasRef.current,
      () => containerRef.current,
      () => (viewer.active ? viewer.getVideoRect() : capture.getVideoRect()),
    );
    return { bus, socket, viewer, capture, overlay };
    // cameraId 变化时外层通过 key 重建本组件，这里无需依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { bus, socket, viewer, capture, overlay } = core;

  /* ── UI 状态 ── */
  const [connected, setConnected] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [viewerActive, setViewerActive] = useState(false);
  const [consumeActive, setConsumeActive] = useState(false);
  const [consumeStatus, setConsumeStatus] = useState<ConsumeStatus | null>(null);
  const [consumeBusy, setConsumeBusy] = useState(false);
  const [deviceStreamBusy, setDeviceStreamBusy] = useState(false);
  const [deviceStreamStopBusy, setDeviceStreamStopBusy] = useState(false);
  const [streamUrl, setStreamUrl] = useState(
    () => localStorage.getItem("vision_stream_url") || "",
  );
  const [issEnv, setIssEnv] = useState<IssEnv>(() => {
    const saved = localStorage.getItem("vision_iss_env");
    return saved === "prod" ? "prod" : "test";
  });
  const [snDraft, setSnDraft] = useState(cameraId);
  const [params, setParams] = useState<TunableParams | null>(null);
  const [correctionEnabled, setCorrectionEnabled] = useState(false);
  const [qualityThresholds, setQualityThresholds] = useState<QualityThresholds>({
    face: 0.3,
    body: 0.2,
  });
  const [overlayOpts, setOverlayOpts] = useState<OverlayOptions>({
    showBbox: true,
    showSkeleton: true,
    showTrail: true,
    showLabels: true,
  });

  /* 本地摄像头选择（多摄像头时 Start Camera 右侧出现下拉） */
  const [localCameras, setLocalCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraMenuOpen, setCameraMenuOpen] = useState(false);
  const [selectedCameraId, setSelectedCameraId] = useState(
    () => localStorage.getItem("vision_local_camera_id") || "",
  );
  const [streamMenuOpen, setStreamMenuOpen] = useState(false);

  /* 弹窗 */
  const [confirmPerson, setConfirmPerson] = useState<TrackedPerson | null>(null);
  const [restreamLogOpen, setRestreamLogOpen] = useState(false);
  const [testModal, setTestModal] = useState<TestModalKind | null>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  const { toasts, showToast } = useToasts();

  /** 已删除 person_id：防止 WS 帧数据在删除后又把人加回花名册 */
  const deletedIdsRef = useRef<Set<string>>(new Set());
  /** 拉流开关的即时值（供 3s 轮询闭包读取） */
  const consumeActiveRef = useRef(false);

  const requireDeviceSn = useCallback((): boolean => {
    if (cameraId) return true;
    alert("请先在左侧输入框填写设备 SN");
    snInputRef.current?.focus();
    return false;
  }, [cameraId]);

  /* ── 服务端拉流消费 ── */

  const setConsumeUI = useCallback((active: boolean) => {
    consumeActiveRef.current = active;
    setConsumeActive(active);
    if (active) {
      viewer.start();
    } else {
      viewer.stop();
      setConsumeStatus(null);
    }
  }, [viewer]);

  const pollConsumeStatus = useCallback(async () => {
    if (!cameraId) return;
    try {
      const st = await fetchConsumeStatus(cameraId);
      setConsumeStatus(st);
      // 自动重推流后服务端换了直播地址 → 同步到输入框（输入框聚焦时不打断编辑）
      if (st.running && st.url && document.activeElement !== streamUrlInputRef.current) {
        const url = st.url;
        setStreamUrl((prev) => {
          if (prev !== url) {
            localStorage.setItem("vision_stream_url", url);
            showToast("📡 拉流失败已自动重推流，新直播地址已同步到输入框");
          }
          return url;
        });
      }
      if (!st.running && consumeActiveRef.current) {
        setConsumeUI(false);
        showToast("⚠️ 服务端拉流已停止", "error", 5000);
      }
      if (st.running && !consumeActiveRef.current) {
        // 别处开的流（web 控制台/服务重启恢复）→ 本页自动进入观看模式
        setConsumeUI(true);
      }
    } catch {
      /* 网络抖动忽略，下个周期重试 */
    }
  }, [cameraId, setConsumeUI, showToast]);

  const syncConsumeState = useCallback(async () => {
    if (!cameraId) return;
    try {
      const st = await fetchConsumeStatus(cameraId);
      setConsumeStatus(st);
      if (st.running && !consumeActiveRef.current) {
        if (st.url) setStreamUrl(st.url);
        setConsumeUI(true);
      } else if (!st.running && consumeActiveRef.current) {
        setConsumeUI(false);
      }
    } catch {
      /* 服务端不可达时忽略，等下次重连再同步 */
    }
  }, [cameraId, setConsumeUI]);

  /* ── 服务端配置加载 ── */
  const loadServerConfig = useCallback(async () => {
    try {
      const data = await fetchVisionConfig();
      if (data.params) setParams(data.params);
      if (data.flags) {
        setQualityThresholds({
          face: data.flags.AGG_MIN_FACE_QUALITY ?? 0.3,
          body: data.flags.AGG_MIN_BODY_QUALITY ?? 0.2,
        });
        if (data.flags.IMAGE_CORRECTION_ENABLED != null) {
          setCorrectionEnabled(!!data.flags.IMAGE_CORRECTION_ENABLED);
        }
      }
      console.log("[Vision] Config loaded from server");
    } catch {
      console.log("[Vision] Could not load config from server, using defaults");
    }
  }, []);

  /* ── 控制器装配（挂载一次） ── */
  useEffect(() => {
    socket.onResult = (result) => {
      let persons = flattenPersons(result.tracked_persons || result.persons || []);
      // 清除已删除用户的身份标记
      const deletedIds = deletedIdsRef.current;
      if (deletedIds.size > 0) {
        persons = persons.map((p) =>
          p.person_id && deletedIds.has(p.person_id)
            ? { ...p, person_id: null, display_name: null, identity_status: "identifying" }
            : p,
        );
      }
      // 拉流观看模式: 识别坐标基准 = 服务端处理帧尺寸
      if (result.frame_w && result.frame_h) {
        viewer.setFrameSize(result.frame_w, result.frame_h);
      }
      overlay.update(persons);
      bus.emit("frameResult", { ...result, tracked_persons: persons });
      capture.onResultReceived();
    };
    socket.onEvent = (event) => {
      if (event?.event_type) bus.emit("event", event);
    };
    socket.onStatusChange = (c) => {
      setConnected(c);
      bus.emit("connected", c);
    };
    socket.onConnected = () => {
      void loadServerConfig();
      // WS 重连后后端状态已刷新，清除前端的删除标记
      deletedIdsRef.current.clear();
      void syncConsumeState();
    };
    socket.onBinaryFrame = (buf) => viewer.onFrame(buf);
    socket.getViewerFPS = () => (viewer.active ? viewer.currentFPS : null);
    socket.onIdentityConfirmed = (name) => showToast(`✅ 已确认身份: ${name}`);
    socket.onServerError = (_code, message) => showToast(`❌ ${message}`, "error", 5000);

    viewer.onDraw = () => socket.refreshFpsFromViewer();
    viewer.onActiveChange = (active) => setViewerActive(active);
    viewer.onAutoStart = () => {
      // 收到服务端帧但本页未点按钮 → 同步按钮与轮询状态
      consumeActiveRef.current = true;
      setConsumeActive(true);
      void pollConsumeStatus();
    };
    capture.onCaptureChange = (c) => setCapturing(c);

    if (cameraId) socket.connect();
    void syncConsumeState();
    const statusTimer = setInterval(() => void pollConsumeStatus(), 3000);

    const onResize = () => overlay.update(overlay.persons);
    window.addEventListener("resize", onResize);

    return () => {
      clearInterval(statusTimer);
      window.removeEventListener("resize", onResize);
      socket.disconnect();
      capture.destroy();
      viewer.stop();
    };
    // 装配只做一次：全部依赖都是挂载期单例 / 稳定回调
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── 设备 SN 应用（失焦 / 回车） ── */
  const applyDeviceSn = () => {
    const sn = snDraft.trim();
    if (sn === cameraId) return;
    if (sn) localStorage.setItem("vision_camera_id", sn);
    else localStorage.removeItem("vision_camera_id");
    localStorage.removeItem("vision_stream_url"); // 流地址跟设备走，换设备后作废
    onCameraIdChange(sn);
  };

  /* ── 摄像头开关 ── */
  const validLocalCameraId = () =>
    localCameras.some((d) => d.deviceId === selectedCameraId) ? selectedCameraId : null;

  const toggleCamera = async () => {
    if (!requireDeviceSn()) return;
    if (consumeActive && !capture.capturing) {
      alert("服务端拉流进行中，无需本地采集。如需切换请先停止服务端拉流。");
      return;
    }
    if (capture.capturing) {
      capture.stop();
      return;
    }
    const url = streamUrl.trim();
    if (url) {
      localStorage.setItem("vision_stream_url", url);
      capture.setSourceType("network");
      capture.setStreamUrl(url);
      await capture.start();
    } else {
      localStorage.removeItem("vision_stream_url");
      capture.setSourceType("local");
      if (!capture.devicesEnumerated) {
        const cams = await capture.enumerateDevices();
        capture.devicesEnumerated = true;
        setLocalCameras(cams);
      }
      await capture.start(validLocalCameraId());
    }
  };

  const selectLocalCamera = async (deviceId: string) => {
    setCameraMenuOpen(false);
    if (deviceId === (validLocalCameraId() || localCameras[0]?.deviceId)) return;
    setSelectedCameraId(deviceId);
    localStorage.setItem("vision_local_camera_id", deviceId);
    // 正在本地采集 → 直接热切换摄像头
    if (capture.capturing && capture.sourceType !== "network") {
      capture.stop();
      await capture.start(deviceId);
    }
  };

  /* ── 设备推流（ISS） ── */
  const handleDeviceStreamStart = async () => {
    if (!requireDeviceSn()) return;
    setDeviceStreamBusy(true);
    const prevUrl = streamUrl;
    setStreamUrl("");
    try {
      const data = await startDeviceStream(cameraId, issEnv);
      if (data.flv_url) {
        setStreamUrl(data.flv_url);
        localStorage.setItem("vision_stream_url", data.flv_url);
        showToast(`✅ 设备推流已开启 (${issEnv} 环境), 地址已填入。可点击「服务端拉流」开始识别`);
      } else {
        setStreamUrl(prevUrl);
        showToast("❌ 开启设备推流失败: 未返回直播地址", "error", 6000);
      }
    } catch (e: unknown) {
      setStreamUrl(prevUrl);
      showToast(
        `❌ 开启设备推流失败: ${e instanceof Error ? e.message : String(e)}`,
        "error", 6000,
      );
    } finally {
      setDeviceStreamBusy(false);
    }
  };

  const handleDeviceStreamStop = async () => {
    setStreamMenuOpen(false);
    if (!requireDeviceSn()) return;
    setDeviceStreamStopBusy(true);
    try {
      // 服务端还在消费该流的话先停消费，避免消费器对着死流反复重连
      if (consumeActiveRef.current) {
        await stopConsume(cameraId).catch(() => {});
        setConsumeUI(false);
      }
      await stopDeviceStream(cameraId, issEnv);
      setStreamUrl("");
      localStorage.removeItem("vision_stream_url");
      showToast(`✅ 设备推流已停止 (${issEnv} 环境)`);
    } catch (e: unknown) {
      showToast(
        `❌ 停止推流失败: ${e instanceof Error ? e.message : String(e)}`,
        "error", 6000,
      );
    } finally {
      setDeviceStreamStopBusy(false);
    }
  };

  /* ── 服务端拉流开关 ── */
  const toggleConsume = async () => {
    if (!requireDeviceSn()) return;
    setConsumeBusy(true);
    try {
      if (!consumeActiveRef.current) {
        const url = streamUrl.trim();
        if (!url) {
          alert("请先填写视频流地址（可点击「📡 设备推流」自动获取）");
          return;
        }
        // 与本地采集互斥: 先停掉浏览器端采集
        if (capture.capturing) capture.stop();
        localStorage.setItem("vision_stream_url", url);
        await startConsume(cameraId, url, issEnv);
        setConsumeUI(true);
        void pollConsumeStatus();
      } else {
        await stopConsume(cameraId).catch((e: unknown) => {
          console.warn("[Vision] Stop consume failed:", e);
        });
        setConsumeUI(false);
      }
    } catch (e: unknown) {
      alert(`操作失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConsumeBusy(false);
    }
  };

  /* ── 叠加层开关 / 畸变矫正 ── */
  const setOverlayOpt = (key: keyof OverlayOptions, value: boolean) => {
    setOverlayOpts((prev) => ({ ...prev, [key]: value }));
    overlay.setOption(key, value);
  };

  const toggleCorrection = (checked: boolean) => {
    setCorrectionEnabled(checked);
    void updateVisionConfig({ IMAGE_CORRECTION_ENABLED: checked }).catch((e: unknown) => {
      console.error("[Vision] Config update failed:", e);
    });
  };

  /* ── 画面点击 → 命中人物 → 身份确认弹窗 ── */
  const handleOverlayClick = (e: React.MouseEvent) => {
    const person = overlay.hitTest(e.clientX, e.clientY);
    if (person) setConfirmPerson(person);
  };

  /* ── 下拉菜单点击外部关闭 ── */
  useEffect(() => {
    if (!cameraMenuOpen && !streamMenuOpen) return;
    const close = () => {
      setCameraMenuOpen(false);
      setStreamMenuOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [cameraMenuOpen, streamMenuOpen]);

  /* ── Context ── */
  const openLightbox = useCallback(
    (src: string, bbox?: number[] | null, color?: string) =>
      setLightbox({ src, bbox, color }),
    [],
  );
  // 弹层 portal 目标（callback ref 挂载后触发一次重渲染, 让 context 拿到元素）
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  const ctxValue = useMemo<VisionContextValue>(() => ({
    cameraId,
    bus,
    socket,
    qualityThresholds,
    showToast: showToast as (message: string, type?: ToastType, duration?: number) => void,
    openLightbox,
    portalTarget: rootEl,
  }), [cameraId, bus, socket, qualityThresholds, showToast, openLightbox, rootEl]);

  /* 拉流状态徽章文案 */
  const consumeBadge = (() => {
    if (!consumeStatus?.running) return null;
    if (consumeStatus.connected) {
      const viewers = (consumeStatus.viewers || 0) > 1 ? ` · ${consumeStatus.viewers} 人观看` : "";
      return {
        cls: "ok",
        text: `🟢 拉流中 ${consumeStatus.stream_width}×${consumeStatus.stream_height}`
          + ` @ ${(consumeStatus.process_fps || 0).toFixed(1)}fps${viewers}`,
        title: "",
      };
    }
    if (consumeStatus.last_error) {
      return { cls: "err", text: `🔴 ${consumeStatus.last_error}`, title: consumeStatus.last_error };
    }
    return { cls: "warn", text: "🟡 正在连接视频流...", title: "" };
  })();

  const currentLocalCameraId = validLocalCameraId() || localCameras[0]?.deviceId;

  return (
    <VisionContext.Provider value={ctxValue}>
      <div className="vision-view" ref={setRootEl}>
        {/* ── 头部状态条 ── */}
        <header className="vision-header">
          <div className="header-left">
            <div className="logo">
              <span className="logo-icon">👁️</span>
              <h1>Vision ID</h1>
            </div>
            <span className="header-subtitle">Robot Person Identification System</span>
          </div>
          <div className="header-right">
            <div className="status-group">
              {consumeBadge && (
                <div className={`consume-status ${consumeBadge.cls}`} title={consumeBadge.title}>
                  {consumeBadge.text}
                </div>
              )}
              <div className={`status-badge ${connected ? "connected" : "disconnected"}`}>
                <span className="status-dot" />
                <span className="status-text">{connected ? "Connected" : "Disconnected"}</span>
              </div>
              <StatsBadges socket={socket} />
              <button className="btn btn-xs" title="Test Body Quality" onClick={() => setTestModal("quality")}>
                🧪 Test
              </button>
              <button className="btn btn-xs" title="Test Face Similarity" onClick={() => setTestModal("face")}>
                🔍 Face Sim
              </button>
              <button className="btn btn-xs" title="Test Body Similarity" onClick={() => setTestModal("body")}>
                🧍 Body Sim
              </button>
            </div>
          </div>
        </header>

        {/* ── 主区: 视频 + 右侧面板 ── */}
        <main className="vision-main">
          <section className="video-section">
            <div className="panel-header">
              <h2>📹 Video Feed</h2>
              <div className="video-controls">
                <div className="split-btn">
                  <button
                    className={`btn btn-primary split-btn-main ${capturing ? "active" : ""}`}
                    onClick={() => void toggleCamera()}
                  >
                    <span className="btn-icon">{capturing ? "⏹" : "▶"}</span>{" "}
                    {capturing ? "Stop Camera" : "Start Camera"}
                  </button>
                  {localCameras.length > 1 && (
                    <button
                      className="btn btn-primary split-btn-caret"
                      title="选择本地摄像头"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCameraMenuOpen((v) => !v);
                      }}
                    >
                      ▾
                    </button>
                  )}
                  {cameraMenuOpen && (
                    <div className="split-menu" onClick={(e) => e.stopPropagation()}>
                      {localCameras.map((d, idx) => {
                        const checked = d.deviceId === currentLocalCameraId;
                        return (
                          <button
                            key={d.deviceId}
                            className={`split-menu-item ${checked ? "checked" : ""}`}
                            onClick={() => void selectLocalCamera(d.deviceId)}
                          >
                            {checked ? "✓" : "\u3000"} {d.label || `Camera ${idx + 1}`}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="stream-url-group">
                  <input
                    ref={snInputRef}
                    type="text"
                    className="text-input stream-url-input device-sn-input"
                    placeholder="设备 SN"
                    title="设备号 (camera_id), 修改后回车切换设备"
                    value={snDraft}
                    onChange={(e) => setSnDraft(e.target.value)}
                    onBlur={applyDeviceSn}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        applyDeviceSn();
                      }
                    }}
                  />
                  <select
                    className="select-input iss-env-select"
                    title="推流服务 (ISS) 环境: test=测试环境, prod=生产环境"
                    value={issEnv}
                    onChange={(e) => {
                      const env = e.target.value as IssEnv;
                      setIssEnv(env);
                      localStorage.setItem("vision_iss_env", env);
                    }}
                  >
                    <option value="test">test</option>
                    <option value="prod">prod</option>
                  </select>
                  <div className="split-btn">
                    <button
                      className="btn split-btn-main"
                      title="开启设备推流并获取直播地址 (ISS start_stream)"
                      disabled={deviceStreamBusy}
                      onClick={() => void handleDeviceStreamStart()}
                    >
                      {deviceStreamBusy ? "⏳ 获取中..." : "📡 设备推流"}
                    </button>
                    <button
                      className="btn split-btn-caret"
                      title="更多操作"
                      onClick={(e) => {
                        e.stopPropagation();
                        setStreamMenuOpen((v) => !v);
                      }}
                    >
                      ▾
                    </button>
                    {streamMenuOpen && (
                      <div className="split-menu" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="split-menu-item"
                          title="查看拉流失败自动重推流的历史记录与错误日志"
                          onClick={() => {
                            setStreamMenuOpen(false);
                            setRestreamLogOpen(true);
                          }}
                        >
                          🧾 重推日志
                        </button>
                        <button
                          className="split-menu-item danger"
                          title="停止设备推流 (ISS stop_stream)"
                          disabled={deviceStreamStopBusy}
                          onClick={() => void handleDeviceStreamStop()}
                        >
                          ⏹ 停止推流
                        </button>
                      </div>
                    )}
                  </div>
                  <input
                    ref={streamUrlInputRef}
                    type="text"
                    className={`text-input stream-url-input ${deviceStreamBusy ? "loading" : ""}`}
                    placeholder={deviceStreamBusy
                      ? "正在开启设备推流, 获取直播地址..."
                      : "Stream URL (留空用本地摄像头)"}
                    readOnly={deviceStreamBusy}
                    value={streamUrl}
                    onChange={(e) => setStreamUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void toggleCamera();
                      }
                    }}
                  />
                  <button
                    className={`btn btn-primary ${consumeActive ? "active" : ""}`}
                    title="服务端后台拉流识别, 页面实时观看"
                    disabled={consumeBusy}
                    onClick={() => void toggleConsume()}
                  >
                    <span className="btn-icon">{consumeActive ? "⏹" : "▶"}</span>{" "}
                    {consumeActive ? "停止拉流" : "服务端拉流"}
                  </button>
                </div>

                <div className="toggle-group">
                  {([
                    ["showBbox", "BBox", "Bounding Boxes"],
                    ["showSkeleton", "Skeleton", "Skeleton Keypoints"],
                    ["showTrail", "Trail", "Tracking Trails"],
                    ["showLabels", "Labels", "Labels"],
                  ] as Array<[keyof OverlayOptions, string, string]>).map(([key, label, title]) => (
                    <label key={key} className="toggle" title={title}>
                      <input
                        type="checkbox"
                        checked={overlayOpts[key]}
                        onChange={(e) => setOverlayOpt(key, e.target.checked)}
                      />
                      <span className="toggle-label">{label}</span>
                    </label>
                  ))}
                  <span className="toggle-divider" />
                  <label className="toggle toggle-correction" title="Lens Distortion Correction (镜头畸变矫正)">
                    <input
                      type="checkbox"
                      checked={correctionEnabled}
                      onChange={(e) => toggleCorrection(e.target.checked)}
                    />
                    <span className="toggle-label">📐 Correct</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="video-container" ref={containerRef}>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                style={viewerActive ? { display: "none" } : undefined}
              />
              <canvas
                ref={serverCanvasRef}
                className="server-stream-canvas"
                style={viewerActive ? undefined : { display: "none" }}
              />
              <canvas
                ref={overlayCanvasRef}
                className="overlay-canvas"
                onClick={handleOverlayClick}
              />
              {!capturing && !viewerActive && (
                <div className="no-camera-message">
                  <span className="no-camera-icon">📷</span>
                  <p>{cameraId ? 'Click "Start Camera" to begin' : "请先在上方输入框填写设备 SN"}</p>
                </div>
              )}
            </div>
          </section>

          <aside className="side-panels">
            <PipelinePanel />
            <ControlsPanel params={params} />
          </aside>
        </main>

        {/* ── 底部: 事件时间线 + 花名册 ── */}
        <footer className="vision-footer">
          <EventsTimeline />
          <PersonGallery deletedIdsRef={deletedIdsRef} />
        </footer>

        {/* ── 弹窗 ── */}
        {confirmPerson && (
          <ConfirmIdentityModal person={confirmPerson} onClose={() => setConfirmPerson(null)} />
        )}
        {restreamLogOpen && <RestreamLogModal onClose={() => setRestreamLogOpen(false)} />}
        {testModal === "quality" && <TestBodyQualityModal onClose={() => setTestModal(null)} />}
        {testModal === "face" && <FaceSimilarityModal onClose={() => setTestModal(null)} />}
        {testModal === "body" && <BodySimilarityModal onClose={() => setTestModal(null)} />}
        {lightbox && <ImageLightbox state={lightbox} onClose={() => setLightbox(null)} />}
        <ToastContainer toasts={toasts} />
      </div>
    </VisionContext.Provider>
  );
}

/** 视觉识别页签入口：管理设备 SN，切换时整体重建仪表盘（对应原版整页刷新） */
export function VisionView() {
  const [cameraId, setCameraId] = useState(
    () => localStorage.getItem("vision_camera_id") || "",
  );
  return (
    <VisionDashboard
      key={cameraId || "(none)"}
      cameraId={cameraId}
      onCameraIdChange={setCameraId}
    />
  );
}
