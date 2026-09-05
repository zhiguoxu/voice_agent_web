import {
  fetchDeviceOverrideSummary,
  fetchSessions,
  type ConfigService,
  type DeviceOverrideSummaryItem,
} from "./api";

/* 设备选择器（DevicePicker）的候选数据：与组件分开放，组件文件只导出组件以保住 fast refresh */

export interface DeviceCandidate {
  sn: string;
  name: string;
}

export function deviceLabel(sn: string, name: string): string {
  return name ? `${name} (${sn})` : sn;
}

/** 选择器候选集：最近有会话的设备 + 指定服务里有设备级覆盖的设备。
    summary 是各服务覆盖条数按设备合并后的总览（防遗忘入口用）。 */
export async function loadDeviceCandidates(services: ConfigService[]): Promise<{
  summary: Map<string, DeviceOverrideSummaryItem>;
  candidates: DeviceCandidate[];
}> {
  const [sessions, summaries] = await Promise.all([
    fetchSessions({ page_size: 50 }).catch(() => null),
    Promise.allSettled(services.map((s) => fetchDeviceOverrideSummary(s))),
  ]);
  const merged = new Map<string, DeviceOverrideSummaryItem>();
  for (const r of summaries) {
    if (r.status !== "fulfilled") continue;
    for (const d of r.value.devices) {
      const prev = merged.get(d.device_sn);
      merged.set(d.device_sn, {
        device_sn: d.device_sn,
        name: d.name || prev?.name || "",
        override_count: (prev?.override_count ?? 0) + d.override_count,
      });
    }
  }

  const seen = new Map<string, string>();
  if (sessions) {
    for (const s of sessions.items) {
      if (!seen.has(s.device_sn)) seen.set(s.device_sn, s.device_name || "");
    }
  }
  for (const d of merged.values()) {
    if (!seen.has(d.device_sn)) seen.set(d.device_sn, d.name);
  }
  return {
    summary: merged,
    candidates: [...seen.entries()].map(([sn, name]) => ({ sn, name })),
  };
}
