/**
 * person_id 视觉识别服务的前端类型定义。
 *
 * 从 person_id/frontend 原生 JS 移植而来，字段与后端
 * person_id/src/api 的 WebSocket / REST 载荷一一对应。
 */

/** 单个被追踪人物（frame_result 中 TrackedPersonResponse 展平后的形态） */
export interface TrackedPerson {
  track_id: number;
  /** 检测框 [x1, y1, x2, y2]，坐标基于服务端处理帧尺寸 */
  bbox?: number[];
  /** COCO 17 关键点 [x, y, conf][] */
  keypoints?: number[][];
  pose_bucket?: string;
  attention_score?: number;
  /** 追踪轨迹点 [x, y][] */
  trail?: number[][];
  person_id?: string | null;
  display_name?: string | null;
  identity_status?: string;
  /** 旧字段名兜底（部分载荷用 status） */
  status?: string;
  confidence?: number;
  face_quality?: number;
  is_current_target?: boolean;
}

/** frame_result 中嵌套的原始形态（p.person + p.identity_result） */
export interface RawTrackedPerson extends TrackedPerson {
  person?: {
    track_id: number;
    detection?: { bbox?: number[]; keypoints?: number[][]; pose_bucket?: string };
    attention_score?: number;
    trail?: number[][];
  };
  identity_result?: {
    person_id?: string | null;
    display_name?: string | null;
    status?: string;
    confidence?: number;
    face_quality?: number;
  };
}

export interface PipelineStageData {
  status?: "done" | "running" | "pending" | "skipped" | "error" | string;
  time_ms?: number;
  details?: {
    count?: number;
    thumbnails_base64?: string[];
    detected?: number;
    total?: number;
    results?: Array<{
      track_id?: number;
      quality?: number | null;
      extracted?: boolean;
      feature_dim?: number;
    }>;
  };
}

export type PipelineStageName = "detection" | "face_detect" | "face_assess" | "reid";

export type PipelineDebug = Partial<Record<PipelineStageName, PipelineStageData>>;

export interface FrameResult {
  type: "frame_result";
  tracked_persons?: RawTrackedPerson[];
  persons?: RawTrackedPerson[];
  pipeline_debug?: PipelineDebug;
  processing_ms?: number;
  /** 服务端处理帧尺寸（拉流观看模式下识别坐标的基准） */
  frame_w?: number;
  frame_h?: number;
}

export interface MatchCandidate {
  person_id?: string;
  display_name?: string;
  fused_score?: number;
  face_score?: number;
  body_score?: number;
  proportion_score?: number;
}

export interface VisionEvent {
  type?: string;
  event_type: string;
  track_id?: number | null;
  timestamp?: number;
  /** IdentityStatus（definite/confident/suspected/conflict/stranger 等） */
  message?: string;
  person_id?: string | null;
  display_name?: string | null;
  fused_score?: number | null;
  candidates?: MatchCandidate[];
}

/** 可调参数（GET /api/config 的 params 字段） */
export interface TunableParam {
  value: number;
  min: number;
  max: number;
  step: number;
  group?: string;
  label?: string;
}

export type TunableParams = Record<string, TunableParam>;

export interface VisionConfig {
  params?: TunableParams;
  flags?: Record<string, unknown> & {
    AGG_MIN_FACE_QUALITY?: number;
    AGG_MIN_BODY_QUALITY?: number;
    IMAGE_CORRECTION_ENABLED?: boolean;
  };
}

/** 底库人物概要（GET /api/{camera_id}/gallery/persons） */
export interface GalleryPersonSummary {
  person_id: string;
  display_name?: string;
  avatar_b64?: string | null;
}

export interface FeatureEntry {
  quality_score: number;
  timestamp?: number;
  pose_bucket?: string;
  source_image_b64?: string;
  /** 特征来源图上的框线 [x1, y1, x2, y2]（原图像素坐标） */
  overlay_bbox?: number[];
}

export interface WardrobeOutfit {
  quality_score: number;
  first_seen?: number;
  last_seen?: number;
  seen_count: number;
}

export interface BodyProportions {
  samples: number;
  torso_leg_ratio: number;
  shoulder_hip_ratio: number;
  arm_torso_ratio: number;
  head_body_ratio: number;
  relative_height_px: number;
}

/** 底库人物详情（GET /api/{camera_id}/gallery/person/{person_id}） */
export interface GalleryPersonDetail {
  person_id: string;
  display_name: string;
  created_at?: number;
  last_updated?: number;
  update_count?: number;
  /** pose_bucket → 特征列表 */
  face_features?: Record<string, FeatureEntry[]>;
  body_features?: Record<string, FeatureEntry[]>;
  wardrobe?: WardrobeOutfit[];
  body_proportions?: BodyProportions | null;
  vlm_description?: string | null;
}

/** 服务端拉流消费状态（GET /api/{camera_id}/consume/status） */
export interface ConsumeStatus {
  running: boolean;
  connected?: boolean;
  url?: string | null;
  stream_width?: number;
  stream_height?: number;
  process_fps?: number;
  viewers?: number;
  last_error?: string | null;
}

/** track 质量帧缓存（GET /api/{camera_id}/track/{track_id}/quality_cache） */
export interface QualityCacheItem {
  image_b64: string;
  quality: number;
  pose_bucket: string;
  timestamp?: number;
  enrolled?: boolean;
}

export interface QualityCache {
  face_pool?: QualityCacheItem[];
  body_pool?: QualityCacheItem[];
}

/** 自动重推流日志（GET /api/{camera_id}/device_stream/restream_log） */
export interface RestreamLogLine {
  time?: number;
  level: string;
  message: string;
}

export interface RestreamAttempt {
  started_at?: number;
  outcome: string;
  trigger_fail_count?: number;
  trigger_error?: string | null;
  device_online?: boolean | null;
  env?: string;
  old_url?: string | null;
  new_url?: string | null;
  logs?: RestreamLogLine[];
}

/** 体质量测试结果（POST /api/test_body_quality） */
export interface BodyQualityResult {
  error?: string;
  has_person?: boolean;
  quality?: number;
  quality_hint?: number;
  sharpness?: number;
  bbox?: number[];
}

/** 人脸相似度测试结果（POST /api/test_face_similarity） */
export interface FaceSimInfo {
  has_face: boolean;
  face_quality?: number | null;
  aligned_face_b64?: string;
  face_bbox?: number[];
  person_bbox?: number[];
}

export interface FaceSimResult {
  error?: string;
  similarity?: number;
  similarity_bgr?: number | null;
  similarity_rgb?: number | null;
  face1?: FaceSimInfo;
  face2?: FaceSimInfo;
  corrected_image1_b64?: string;
  corrected_image2_b64?: string;
}

/** ReID 对比测试结果（POST /api/test_reid_compare） */
export interface BodySimInfo {
  has_body: boolean;
  body_crop_b64?: string;
  person_bbox?: number[];
}

export interface BodySimResult {
  error?: string;
  solider_similarity?: number | null;
  solider_dim?: number;
  osnet_similarity?: number | null;
  osnet_dim?: number;
  body1?: BodySimInfo;
  body2?: BodySimInfo;
  corrected_image1_b64?: string;
  corrected_image2_b64?: string;
}

/** overlay 坐标基准（本地采集与拉流观看两种模式同构） */
export interface VideoRect {
  offsetX: number;
  offsetY: number;
  displayW: number;
  displayH: number;
  scale: number;
  /** 识别坐标基准宽高（本地=发送帧尺寸；拉流=服务端处理帧尺寸） */
  videoW: number;
  videoH: number;
}

export interface QualityThresholds {
  face: number;
  body: number;
}
