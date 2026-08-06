/**
 * person_id 视觉识别服务 REST 客户端。
 *
 * 同域反向代理约定（vite dev proxy 与生产 nginx 同规则）：
 *   /vision/*  → person_id(:10003)，代理层去掉 /vision 前缀
 * 因此 REST 基址为 /vision/api，WebSocket 为 /vision/ws/vision。
 */
import type {
  BodyQualityResult,
  BodySimResult,
  ConsumeStatus,
  FaceSimResult,
  GalleryPersonDetail,
  GalleryPersonSummary,
  QualityCache,
  RestreamAttempt,
  VisionConfig,
} from "./types";

export const VISION_BASE = "/vision";
export const VISION_API = `${VISION_BASE}/api`;

/** 实时视觉 WebSocket 地址（同域，https 下自动用 wss） */
export function visionWsUrl(cameraId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${VISION_BASE}/ws/vision?camera_id=${encodeURIComponent(cameraId)}`;
}

async function toError(res: Response): Promise<Error> {
  const err = await res.json().catch(() => ({} as { detail?: string }));
  return new Error(err.detail || res.statusText);
}

/* ── 全局配置 ── */

export async function fetchVisionConfig(): Promise<VisionConfig> {
  const res = await fetch(`${VISION_API}/config`);
  if (!res.ok) throw await toError(res);
  return res.json();
}

export async function updateVisionConfig(updates: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${VISION_API}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  if (!res.ok) throw await toError(res);
}

/* ── 底库（gallery） ── */

export async function fetchGalleryPersons(cameraId: string): Promise<GalleryPersonSummary[]> {
  const res = await fetch(`${VISION_API}/${encodeURIComponent(cameraId)}/gallery/persons`);
  if (!res.ok) throw await toError(res);
  const data = await res.json();
  return data.persons || data || [];
}

export async function fetchGalleryPersonDetail(
  cameraId: string,
  personId: string,
): Promise<GalleryPersonDetail> {
  const res = await fetch(
    `${VISION_API}/${encodeURIComponent(cameraId)}/gallery/person/${encodeURIComponent(personId)}`,
  );
  if (!res.ok) throw await toError(res);
  return res.json();
}

export async function renameGalleryPerson(
  cameraId: string,
  personId: string,
  displayName: string,
): Promise<void> {
  const res = await fetch(
    `${VISION_API}/${encodeURIComponent(cameraId)}/gallery/person/${encodeURIComponent(personId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    },
  );
  if (!res.ok) throw await toError(res);
}

export async function deleteGalleryPerson(cameraId: string, personId: string): Promise<void> {
  const res = await fetch(
    `${VISION_API}/${encodeURIComponent(cameraId)}/gallery/person/${encodeURIComponent(personId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw await toError(res);
}

/* ── 设备推流（ISS） ── */

export async function startDeviceStream(
  cameraId: string,
  env: string,
): Promise<{ flv_url?: string }> {
  const res = await fetch(
    `${VISION_API}/${encodeURIComponent(cameraId)}/device_stream/start?env=${env}`,
    { method: "POST" },
  );
  if (!res.ok) throw await toError(res);
  return res.json();
}

export async function stopDeviceStream(cameraId: string, env: string): Promise<void> {
  const res = await fetch(
    `${VISION_API}/${encodeURIComponent(cameraId)}/device_stream/stop?env=${env}`,
    { method: "POST" },
  );
  if (!res.ok) throw await toError(res);
}

export async function fetchRestreamLog(
  cameraId: string,
  limit = 100,
): Promise<{ attempts: RestreamAttempt[] }> {
  const res = await fetch(
    `${VISION_API}/${encodeURIComponent(cameraId)}/device_stream/restream_log?limit=${limit}`,
  );
  if (!res.ok) throw await toError(res);
  const data = await res.json();
  return { attempts: data.attempts || [] };
}

/* ── 服务端拉流消费 ── */

export async function startConsume(
  cameraId: string,
  url: string,
  env: string,
): Promise<void> {
  const res = await fetch(`${VISION_API}/${encodeURIComponent(cameraId)}/consume/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, env, auto_restream: true }),
  });
  if (!res.ok) throw await toError(res);
}

export async function stopConsume(cameraId: string): Promise<void> {
  const res = await fetch(`${VISION_API}/${encodeURIComponent(cameraId)}/consume/stop`, {
    method: "POST",
  });
  if (!res.ok) throw await toError(res);
}

export async function fetchConsumeStatus(cameraId: string): Promise<ConsumeStatus> {
  const res = await fetch(`${VISION_API}/${encodeURIComponent(cameraId)}/consume/status`);
  if (!res.ok) throw await toError(res);
  return res.json();
}

/* ── track 质量帧缓存 ── */

export async function fetchQualityCache(
  cameraId: string,
  trackId: number,
): Promise<QualityCache> {
  const res = await fetch(
    `${VISION_API}/${encodeURIComponent(cameraId)}/track/${trackId}/quality_cache`,
  );
  if (!res.ok) throw await toError(res);
  return res.json();
}

export async function clearQualityCache(cameraId: string, trackId: number): Promise<void> {
  const res = await fetch(
    `${VISION_API}/${encodeURIComponent(cameraId)}/track/${trackId}/quality_cache`,
    { method: "DELETE" },
  );
  if (!res.ok) throw await toError(res);
}

/* ── 调试测试接口 ── */

export async function testBodyQuality(file: File): Promise<BodyQualityResult> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${VISION_API}/test_body_quality`, { method: "POST", body: formData });
  if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
  return res.json();
}

export async function testFaceSimilarity(
  file1: File,
  file2: File,
  undistort: boolean,
): Promise<FaceSimResult> {
  const formData = new FormData();
  formData.append("file1", file1);
  formData.append("file2", file2);
  if (undistort) formData.append("undistort", "true");
  const res = await fetch(`${VISION_API}/test_face_similarity`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
  return res.json();
}

export async function testReidCompare(
  file1: File,
  file2: File,
  undistort: boolean,
): Promise<BodySimResult> {
  const formData = new FormData();
  formData.append("file1", file1);
  formData.append("file2", file2);
  if (undistort) formData.append("undistort", "true");
  const res = await fetch(`${VISION_API}/test_reid_compare`, { method: "POST", body: formData });
  if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
  return res.json();
}
