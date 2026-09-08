/**
 * ISS 推流服务地址覆盖：控制台里所有会开/关设备推流的入口（视觉页「设备推流」、
 * 会话页「摄像头拉流」对话框、「注册人脸」自动开流）共用这一份输入，存在
 * localStorage 里跨页面/刷新保留。
 *
 * 空字符串 = 不覆盖，由 person_id 用自己配置的 iss_api_url；正常使用留空，
 * 只在联调另一套 ISS 时填写。
 */
const STORAGE_KEY = "issApiUrl";

export function loadIssApiUrl(): string {
  return (localStorage.getItem(STORAGE_KEY) || "").trim();
}

export function saveIssApiUrl(value: string): void {
  const v = value.trim();
  if (v) localStorage.setItem(STORAGE_KEY, v);
  else localStorage.removeItem(STORAGE_KEY);
}

export const ISS_API_URL_PLACEHOLDER = "ISS 地址（留空 = 服务端配置）";
