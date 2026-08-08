/**
 * 身份确认弹窗（点击画面中的人物打开）。
 *
 * 从底库加载候选人物卡片，可选已有人物或新建（New Person 默认选中），
 * 提交后经 WebSocket 发送 confirm_identity。
 */
import { useEffect, useRef, useState } from "react";
import { fetchGalleryPersons } from "./api";
import { useVision } from "./context";
import type { GalleryPersonSummary, TrackedPerson } from "./types";

export function ConfirmIdentityModal({ person, onClose }: {
  person: TrackedPerson;
  onClose: () => void;
}) {
  const { cameraId, socket } = useVision();
  const [candidates, setCandidates] = useState<GalleryPersonSummary[]>([]);
  /** 选中的 person_id；空字符串 = New Person */
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let stale = false;
    fetchGalleryPersons(cameraId)
      .then((persons) => { if (!stale) setCandidates(persons); })
      .catch(() => console.log("[Vision] Could not load gallery persons for candidates"));
    nameInputRef.current?.focus();
    return () => { stale = true; };
  }, [cameraId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectCandidate = (personId: string, displayName: string) => {
    setSelectedId(personId);
    setName(personId ? displayName : "");
    if (!personId) nameInputRef.current?.focus();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trackId = person.track_id;
    const trimmed = name.trim();
    if (trackId && trimmed) {
      socket.sendConfirmIdentity(trackId, selectedId || null, trimmed);
      onClose();
    }
  };

  return (
    <div className="modal confirm-identity-modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-content">
        <div className="modal-header">
          <h3>Confirm Identity</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="confirm-candidates-section">
            <label className="confirm-section-label">Select from Gallery</label>
            <div className="confirm-candidates-list">
              <div
                className={`candidate-card new-person ${selectedId === "" ? "selected" : ""}`}
                onClick={() => selectCandidate("", "")}
              >
                <div className="candidate-avatar">＋</div>
                <div className="candidate-info">
                  <span className="candidate-display-name">New Person</span>
                  <span className="candidate-person-id">Create new gallery entry</span>
                </div>
              </div>
              {candidates.map((c) => (
                <div
                  key={c.person_id}
                  className={`candidate-card ${selectedId === c.person_id ? "selected" : ""}`}
                  onClick={() => selectCandidate(c.person_id, c.display_name || "")}
                >
                  <div className="candidate-avatar">
                    {(c.display_name || "?")[0].toUpperCase()}
                  </div>
                  <div className="candidate-info">
                    <span className="candidate-display-name">{c.display_name}</span>
                    <span className="candidate-person-id">{c.person_id}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="form-group" style={{ marginTop: 12 }}>
              <label htmlFor="vision-confirm-name">Name</label>
              <input
                ref={nameInputRef}
                id="vision-confirm-name"
                type="text"
                className="text-input"
                placeholder="Enter name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div style={{ marginTop: 15, display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary">Confirm</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
