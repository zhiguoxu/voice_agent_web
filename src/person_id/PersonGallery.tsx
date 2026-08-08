/**
 * 人物画廊面板 + 个人详情弹窗（从 person_id/frontend/js/person-gallery.js 移植）。
 *
 * 两种显示模式:
 *   - active: 仅显示当前帧匹配到的人 (实时)
 *   - all:    显示数据库中所有已知用户
 *
 * 帧结果 10~30fps 到达，内部用 ref 维护人物 Map，只有展示内容真正
 * 变化时才 setState，避免高频重渲染。
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  deleteGalleryPerson,
  fetchGalleryPersonDetail,
  fetchGalleryPersons,
  renameGalleryPerson,
} from "./api";
import { useVision } from "./context";
import { VisionPortal } from "./VisionPortal";
import type { FeatureEntry, GalleryPersonDetail } from "./types";

const HIGH_CONFIDENCE = new Set(["confident", "definite"]);

interface GalleryPerson {
  person_id: string;
  display_name: string;
  confidence: number;
  thumbnail: string | null;
  first_seen: number;
  last_seen: number;
  present: boolean;
}

function fmtTime(timestamp: number | undefined | null): string {
  if (!timestamp) return "—";
  return new Date(timestamp * 1000).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

function countFeatures(features: Record<string, FeatureEntry[]> | undefined): number {
  if (!features) return 0;
  let count = 0;
  for (const entries of Object.values(features)) count += entries.length;
  return count;
}

/* ── 特征缩略图卡片（带 bbox 叠加框线） ── */

function FeatureCard({ entry, featureType }: {
  entry: FeatureEntry;
  featureType: "face" | "body";
}) {
  const { qualityThresholds, openLightbox } = useVision();
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const boxColor = featureType === "body" ? "#76ff03" : "#00e5ff";
  const lineWidth = featureType === "body" ? 2.5 : 2;

  const drawOverlay = () => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !entry.overlay_bbox) return;

    const naturalW = img.naturalWidth;
    const naturalH = img.naturalHeight;
    const displayW = img.offsetWidth;
    const displayH = img.offsetHeight;
    canvas.width = displayW;
    canvas.height = displayH;

    // 根据 object-fit 模式计算缩放:
    // body 全帧图用 contain (图像完整显示), face 用 cover (居中裁切)
    const scale = featureType === "body"
      ? Math.min(displayW / naturalW, displayH / naturalH)
      : Math.max(displayW / naturalW, displayH / naturalH);
    const offsetX = (displayW - naturalW * scale) / 2;
    const offsetY = (displayH - naturalH * scale) / 2;

    const [x1, y1, x2, y2] = entry.overlay_bbox;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.strokeStyle = boxColor;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(
      x1 * scale + offsetX, y1 * scale + offsetY,
      (x2 - x1) * scale, (y2 - y1) * scale,
    );
  };

  const q = entry.quality_score;
  const minQ = featureType === "body" ? qualityThresholds.body : qualityThresholds.face;
  const qClass = q < minQ ? "gd-quality-low" : "gd-quality-high";

  const src = entry.source_image_b64 ? `data:image/png;base64,${entry.source_image_b64}` : null;

  return (
    <div className="gd-feature-card">
      {src ? (
        entry.overlay_bbox ? (
          <div className="gd-feature-img-wrapper">
            <img
              ref={imgRef}
              className="gd-feature-img"
              style={featureType === "body"
                ? { objectFit: "contain", backgroundColor: "#1a1a2e" }
                : undefined}
              src={src}
              alt={entry.pose_bucket}
              onLoad={drawOverlay}
              onClick={() => openLightbox(src, entry.overlay_bbox, boxColor)}
            />
            <canvas ref={canvasRef} className="gd-feature-canvas" />
          </div>
        ) : (
          <img
            className="gd-feature-img"
            src={src}
            alt={entry.pose_bucket}
            onClick={() => openLightbox(src)}
          />
        )
      ) : (
        <div className="gd-feature-placeholder">📷</div>
      )}
      <div className="gd-feature-info">
        <div className={`gd-feature-quality ${qClass}`}>Q: {q.toFixed(2)}</div>
        <div className="gd-feature-time">{fmtTime(entry.timestamp)}</div>
      </div>
    </div>
  );
}

/* ── 可折叠区块 ── */

function CollapsibleSection({ icon, title, badge, children }: {
  icon: string;
  title: string;
  badge: string | number;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={`gd-section ${collapsed ? "collapsed" : ""}`}>
      <div className="gd-section-header" onClick={() => setCollapsed((c) => !c)}>
        <span className="gd-section-icon">{icon}</span>
        <span className="gd-section-title">{title}</span>
        <span className="gd-section-badge">{badge}</span>
        <span className="gd-section-toggle">▼</span>
      </div>
      <div className="gd-section-body">{children}</div>
    </div>
  );
}

function FeatureSection({ icon, title, features, featureType }: {
  icon: string;
  title: string;
  features: Record<string, FeatureEntry[]> | undefined;
  featureType: "face" | "body";
}) {
  const count = countFeatures(features);
  const bucketOrder = ["frontal", "left", "right", "back"];
  const sortedKeys = features
    ? Object.keys(features).sort((a, b) => {
      const ai = bucketOrder.indexOf(a);
      const bi = bucketOrder.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    : [];

  return (
    <CollapsibleSection icon={icon} title={title} badge={count}>
      {!features || count === 0 ? (
        <div className="gd-empty">No features enrolled</div>
      ) : (
        sortedKeys.map((bucket) => {
          const entries = features[bucket];
          if (!entries || entries.length === 0) return null;
          return (
            <div key={bucket} className="gd-bucket-group">
              <div className="gd-bucket-label">{bucket} ({entries.length})</div>
              <div className="gd-feature-grid">
                {entries.map((entry, i) => (
                  <FeatureCard key={i} entry={entry} featureType={featureType} />
                ))}
              </div>
            </div>
          );
        })
      )}
    </CollapsibleSection>
  );
}

/* ── 个人详情弹窗 ── */

function PersonDetailModal({ person, activeTrackId, onClose, onRenamed, onDeleted }: {
  person: GalleryPerson;
  /** 该人当前在场对应的 track_id（不在场为 null） */
  activeTrackId: number | null;
  onClose: () => void;
  onRenamed: (name: string) => void;
  onDeleted: () => void;
}) {
  const { cameraId, socket } = useVision();
  const [detail, setDetail] = useState<GalleryPersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(person.display_name || person.person_id);

  useEffect(() => {
    if (!cameraId) {
      setError("Camera not connected");
      return;
    }
    let stale = false;
    fetchGalleryPersonDetail(cameraId, person.person_id)
      .then((d) => { if (!stale) setDetail(d); })
      .catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [cameraId, person.person_id]);

  const handleRename = async () => {
    const newName = window.prompt("Enter new name:", person.display_name);
    if (!newName || !newName.trim()) return;
    const trimmed = newName.trim();
    if (!cameraId) {
      alert("Camera not connected");
      return;
    }
    try {
      await renameGalleryPerson(cameraId, person.person_id, trimmed);
      setTitle(trimmed);
      onRenamed(trimmed);
    } catch (e: unknown) {
      alert(`重命名失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleConfirm = () => {
    if (activeTrackId != null) {
      socket.sendConfirmIdentity(activeTrackId, person.person_id, person.display_name);
    }
  };

  const handleDelete = async () => {
    const confirmed = window.confirm(
      `确定要删除 "${person.display_name}" 吗？\n\nPerson ID: ${person.person_id}\n此操作不可恢复。`,
    );
    if (!confirmed) return;
    try {
      await deleteGalleryPerson(cameraId, person.person_id);
      onDeleted();
    } catch (e: unknown) {
      alert(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="modal person-detail-modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-content">
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error ? (
            <div className="gd-empty">Failed to load: {error}</div>
          ) : !detail ? (
            <div className="gd-loading">Loading gallery data…</div>
          ) : (
            <>
              <div className="gd-info-grid">
                <div className="gd-info-item">
                  <label>Person ID</label>
                  <span>{detail.person_id}</span>
                </div>
                <div className="gd-info-item">
                  <label>Display Name</label>
                  <span>{detail.display_name}</span>
                </div>
                <div className="gd-info-item">
                  <label>Created</label>
                  <span>{fmtTime(detail.created_at)}</span>
                </div>
                <div className="gd-info-item">
                  <label>Last Updated</label>
                  <span>{fmtTime(detail.last_updated)}</span>
                </div>
                <div className="gd-info-item">
                  <label>Update Count</label>
                  <span>{detail.update_count}</span>
                </div>
                <div className="gd-info-item">
                  <label>Face / Body / Wardrobe</label>
                  <span>
                    {countFeatures(detail.face_features)} / {countFeatures(detail.body_features)} / {(detail.wardrobe || []).length}
                  </span>
                </div>
              </div>

              <FeatureSection icon="👤" title="Face Features"
                features={detail.face_features} featureType="face" />
              <FeatureSection icon="🏃" title="Body Features"
                features={detail.body_features} featureType="body" />

              <CollapsibleSection icon="👔" title="Wardrobe" badge={(detail.wardrobe || []).length}>
                {(detail.wardrobe || []).length === 0 ? (
                  <div className="gd-empty">No wardrobe records</div>
                ) : (
                  <table className="gd-wardrobe-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Quality</th>
                        <th>First Seen</th>
                        <th>Last Seen</th>
                        <th>Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detail.wardrobe || []).map((outfit, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td>{outfit.quality_score.toFixed(3)}</td>
                          <td>{fmtTime(outfit.first_seen)}</td>
                          <td>{fmtTime(outfit.last_seen)}</td>
                          <td>{outfit.seen_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CollapsibleSection>

              <CollapsibleSection
                icon="📐"
                title="Body Proportions"
                badge={detail.body_proportions ? `${detail.body_proportions.samples} samples` : "—"}
              >
                {!detail.body_proportions ? (
                  <div className="gd-empty">No body proportion data</div>
                ) : (
                  <>
                    {[
                      { label: "Torso / Leg", value: detail.body_proportions.torso_leg_ratio, max: 1.5 },
                      { label: "Shoulder / Hip", value: detail.body_proportions.shoulder_hip_ratio, max: 2.0 },
                      { label: "Arm / Torso", value: detail.body_proportions.arm_torso_ratio, max: 2.0 },
                      { label: "Head / Body", value: detail.body_proportions.head_body_ratio, max: 0.5 },
                    ].map((prop) => (
                      <div key={prop.label} className="gd-prop-item">
                        <span className="gd-prop-label">{prop.label}</span>
                        <div className="gd-prop-bar-bg">
                          <div
                            className="gd-prop-bar"
                            style={{ width: `${Math.min(100, (prop.value / prop.max) * 100)}%` }}
                          />
                        </div>
                        <span className="gd-prop-value">{prop.value.toFixed(3)}</span>
                      </div>
                    ))}
                    <div className="gd-prop-item">
                      <span className="gd-prop-label">Height (px)</span>
                      <div className="gd-prop-bar-bg">
                        <div
                          className="gd-prop-bar"
                          style={{ width: `${Math.min(100, detail.body_proportions.relative_height_px / 5)}%` }}
                        />
                      </div>
                      <span className="gd-prop-value">
                        {detail.body_proportions.relative_height_px.toFixed(0)}
                      </span>
                    </div>
                  </>
                )}
              </CollapsibleSection>

              <CollapsibleSection
                icon="🧠"
                title="VLM Description"
                badge={detail.vlm_description ? "Available" : "—"}
              >
                {!detail.vlm_description ? (
                  <div className="gd-empty">No VLM description available</div>
                ) : (
                  <div className="gd-vlm-text">{detail.vlm_description}</div>
                )}
              </CollapsibleSection>

              <div className="gd-actions">
                <button className="btn" onClick={handleRename}>✏️ Rename</button>
                {person.present && activeTrackId != null && (
                  <button className="btn" onClick={handleConfirm}>✅ Confirm</button>
                )}
                <button className="btn btn-danger" onClick={handleDelete}>🗑️ Delete</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── 主面板 ── */

export function PersonGallery({ deletedIdsRef }: {
  /** 已删除 person_id 集合（与帧结果流转共享，防止 WS 帧数据重新添加） */
  deletedIdsRef: MutableRefObject<Set<string>>;
}) {
  const { bus, cameraId } = useVision();
  const [mode, setMode] = useState<"active" | "all">("active");
  const [, setTick] = useState(0); // ref Map 变化后的受控重渲染
  const [detailPerson, setDetailPerson] = useState<GalleryPerson | null>(null);

  const personsRef = useRef(new Map<string, GalleryPerson>()); // session 实时
  const allPersonsRef = useRef(new Map<string, GalleryPerson>()); // 底库全量
  const activeTracksRef = useRef(new Map<string, number>()); // person_id → track_id
  const avatarRefreshingRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // 上次渲染的展示签名，仅内容变化时重渲染
  const signatureRef = useRef("");

  const rerenderIfChanged = () => {
    const source = modeRef.current === "all" ? allPersonsRef.current : personsRef.current;
    const sig = [...source.values()]
      .map((p) => `${p.person_id}|${p.display_name}|${p.present ? 1 : 0}|${p.thumbnail ? 1 : 0}`)
      .join(";") + `#${modeRef.current}`;
    if (sig !== signatureRef.current) {
      signatureRef.current = sig;
      setTick((t) => t + 1);
    }
  };

  /** 从底库补齐实时在场人物的头像 (质量最高的人脸特征图), 5s 节流 */
  const refreshAvatars = async () => {
    if (avatarRefreshingRef.current || !cameraId) return;
    avatarRefreshingRef.current = true;
    setTimeout(() => { avatarRefreshingRef.current = false; }, 5000);
    try {
      const persons = await fetchGalleryPersons(cameraId);
      for (const p of persons) {
        if (!p.avatar_b64) continue;
        const entry = personsRef.current.get(p.person_id);
        if (entry && !entry.thumbnail) entry.thumbnail = p.avatar_b64;
        const allEntry = allPersonsRef.current.get(p.person_id);
        if (allEntry && !allEntry.thumbnail) allEntry.thumbnail = p.avatar_b64;
      }
      rerenderIfChanged();
    } catch { /* 静默, 下次创建条目时再试 */ }
  };

  /** 从 API 拉取全部 gallery 用户 */
  const fetchAllPersons = async () => {
    if (!cameraId) return;
    try {
      const persons = await fetchGalleryPersons(cameraId);
      allPersonsRef.current.clear();
      for (const p of persons) {
        const sessionData = personsRef.current.get(p.person_id);
        allPersonsRef.current.set(p.person_id, {
          person_id: p.person_id,
          display_name: p.display_name || p.person_id,
          confidence: sessionData?.confidence ?? 0,
          thumbnail: p.avatar_b64 || null,
          first_seen: sessionData?.first_seen ?? Date.now(),
          last_seen: sessionData?.last_seen ?? Date.now(),
          present: sessionData?.present ?? false,
        });
      }
      rerenderIfChanged();
    } catch (e) {
      console.error("[Gallery] Failed to fetch all persons:", e);
    }
  };

  useEffect(() => {
    const offResult = bus.on("frameResult", (result) => {
      const persons = result.tracked_persons;
      const activePersonIds = new Set<string>();

      for (const p of persons) {
        if (
          p.person_id &&
          !deletedIdsRef.current.has(p.person_id) &&
          HIGH_CONFIDENCE.has(p.identity_status ?? "")
        ) {
          activePersonIds.add(p.person_id);
          activeTracksRef.current.set(p.person_id, p.track_id);

          const existing = personsRef.current.get(p.person_id);
          if (!existing) {
            personsRef.current.set(p.person_id, {
              person_id: p.person_id,
              display_name: p.display_name || p.person_id,
              confidence: p.confidence ?? 0,
              thumbnail: null,
              first_seen: Date.now(),
              last_seen: Date.now(),
              present: false,
            });
            void refreshAvatars(); // 从底库补头像 (节流)
          } else {
            existing.display_name = p.display_name || existing.display_name;
            existing.confidence = p.confidence ?? existing.confidence;
            existing.last_seen = Date.now();
          }
        }
      }

      // 更新在场/离开状态
      personsRef.current.forEach((person, id) => {
        person.present = activePersonIds.has(id);
      });

      // 在场但还没头像的, 持续尝试从底库补齐 (内部 5s 节流)
      for (const person of personsRef.current.values()) {
        if (person.present && !person.thumbnail) {
          void refreshAvatars();
          break;
        }
      }

      // 同步到 allPersons (更新已有 + 添加新增)
      if (modeRef.current === "all") {
        personsRef.current.forEach((sp, id) => {
          const ap = allPersonsRef.current.get(id);
          if (ap) {
            ap.present = sp.present;
            ap.confidence = sp.confidence;
            ap.display_name = sp.display_name;
            ap.last_seen = sp.last_seen;
          } else {
            allPersonsRef.current.set(id, { ...sp });
          }
        });
      }

      rerenderIfChanged();
    });

    // WS 重连后后端状态已刷新, 清除前端的删除标记
    const offConnected = bus.on("connected", (connected) => {
      if (connected) deletedIdsRef.current.clear();
    });

    return () => {
      offResult();
      offConnected();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, cameraId]);

  const switchMode = (m: "active" | "all") => {
    setMode(m);
    if (m === "all") void fetchAllPersons();
  };

  const source = mode === "all" ? allPersonsRef.current : personsRef.current;
  const displayList = mode === "active"
    ? [...source.values()].filter((p) => p.present)
    : [...source.values()];

  const handleDeleted = (person: GalleryPerson) => {
    deletedIdsRef.current.add(person.person_id);
    personsRef.current.delete(person.person_id);
    allPersonsRef.current.delete(person.person_id);
    activeTracksRef.current.delete(person.person_id);
    setDetailPerson(null);
    rerenderIfChanged();
  };

  const handleRenamed = (person: GalleryPerson, name: string) => {
    const sessionPerson = personsRef.current.get(person.person_id);
    if (sessionPerson) sessionPerson.display_name = name;
    const allPerson = allPersonsRef.current.get(person.person_id);
    if (allPerson) allPerson.display_name = name;
    rerenderIfChanged();
  };

  return (
    <section className="gallery-panel-root">
      <div className="panel-header">
        <h2>👥 Gallery</h2>
        <div className="gallery-tabs">
          <button
            className={`gallery-tab ${mode === "active" ? "active" : ""}`}
            onClick={() => switchMode("active")}
          >
            Active
          </button>
          <button
            className={`gallery-tab ${mode === "all" ? "active" : ""}`}
            onClick={() => switchMode("all")}
          >
            All
          </button>
        </div>
        <span className="badge">{displayList.length} persons</span>
      </div>
      <div className="person-gallery">
        {displayList.length === 0 ? (
          <div className="gallery-empty">
            {mode === "active" ? "No active matches." : "Gallery is empty."}
          </div>
        ) : (
          displayList.map((person) => (
            <div
              key={person.person_id}
              className={`person-card ${person.present ? "active" : ""}`}
              onClick={() => setDetailPerson(person)}
            >
              <div className="person-avatar">
                {person.thumbnail ? (
                  <img
                    src={`data:image/jpeg;base64,${person.thumbnail}`}
                    alt={person.display_name}
                  />
                ) : (
                  (person.display_name || "?")[0].toUpperCase()
                )}
              </div>
              <span className="person-name" title={person.person_id}>
                {person.display_name}
              </span>
              <span className={`person-status-label ${person.present ? "present" : "absent"}`}>
                {person.present ? "● Present" : "○ Away"}
              </span>
            </div>
          ))
        )}
      </div>
      {detailPerson && (
        <VisionPortal>
          <PersonDetailModal
            person={detailPerson}
            activeTrackId={
              detailPerson.present
                ? activeTracksRef.current.get(detailPerson.person_id) ?? null
                : null
            }
            onClose={() => setDetailPerson(null)}
            onRenamed={(name) => handleRenamed(detailPerson, name)}
            onDeleted={() => handleDeleted(detailPerson)}
          />
        </VisionPortal>
      )}
    </section>
  );
}
