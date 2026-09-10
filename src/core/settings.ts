import type { SettingsStore, StoredSettings } from "../ports/stores";
import type { GatewayConfig } from "./app";

export interface GlobalSettings {
  healthCheckEnabled: boolean;
  healthCheckIntervalMs: number;
  mailboxesPerKeyPerHour: number;
  maxConcurrentRequestsPerKey: number;
}

export type RuntimeSettings = GlobalSettings & { adminPasswordHash: string | null };

function validInteger(value: number | undefined, fallback: number, min: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= min ? value : fallback;
}

/** 每次请求/巡检读数据库，避免多进程或 Workers isolate 缓存旧凭证及配置。 */
export async function readSettings(store: SettingsStore, config: GatewayConfig): Promise<RuntimeSettings> {
  const saved = await store.get();
  return {
    adminPasswordHash: saved?.adminPasswordHash ?? null,
    healthCheckEnabled: saved?.healthCheckEnabled ?? true,
    healthCheckIntervalMs: saved?.healthCheckIntervalMs ?? validInteger(config.healthCheckIntervalMs, 300_000, 60_000),
    mailboxesPerKeyPerHour: saved?.mailboxesPerKeyPerHour ?? validInteger(config.mailboxesPerKeyPerHour, 60, 0),
    maxConcurrentRequestsPerKey: saved?.maxConcurrentRequestsPerKey ?? validInteger(config.maxConcurrentRequestsPerKey, 0, 0),
  };
}

/** 显式白名单：密码摘要绝不进入管理 API 的返回值。 */
export function publicSettings(settings: RuntimeSettings): GlobalSettings {
  return {
    healthCheckEnabled: settings.healthCheckEnabled,
    healthCheckIntervalMs: settings.healthCheckIntervalMs,
    mailboxesPerKeyPerHour: settings.mailboxesPerKeyPerHour,
    maxConcurrentRequestsPerKey: settings.maxConcurrentRequestsPerKey,
  };
}

export type SettingsPatch = Partial<StoredSettings>;
