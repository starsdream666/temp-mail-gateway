import { AppError } from "./errors";
import type { UpstreamPatch, UpstreamStore } from "../ports/stores";

function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equalJson(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}

/** 按配置键合并用户改动；同一键同时发生不同修改时拒绝覆盖。null 是值，缺键表示删除。 */
function mergeSettings(base: Record<string, unknown>, draft: Record<string, unknown>, current: Record<string, unknown>) {
  const merged = new Map(Object.entries(current));
  const sameEntry = (a: Record<string, unknown>, b: Record<string, unknown>, key: string) =>
    Object.hasOwn(a, key) === Object.hasOwn(b, key) && equalJson(a[key], b[key]);
  for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
    if (sameEntry(base, draft, key)) continue;
    if (!sameEntry(base, current, key) && !sameEntry(draft, current, key)) {
      throw new AppError("CONFLICT", `配置项「${key}」已被其他操作修改。当前编辑内容已保留，请重新打开编辑框，核对最新配置后再保存。`);
    }
    if (Object.hasOwn(draft, key)) merged.set(key, draft[key]);
    else merged.delete(key);
  }
  return Object.fromEntries(merged);
}

/** 比对与写入是原子的；读取后发生了其他修改就重新合并，适用于 SQLite 和 D1。 */
export async function updateUpstreamWithSettings(
  store: UpstreamStore,
  id: string,
  patch: UpstreamPatch & { settingsJson: Record<string, unknown> },
  base: Record<string, unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await store.get(id);
    if (!current) throw new AppError("NOT_FOUND", `上游不存在: ${id}`);
    const settingsJson = mergeSettings(base, patch.settingsJson, current.settingsJson);
    if (await store.updateIfSettingsMatch(id, { ...patch, settingsJson }, current.settingsJson)) return;
  }
  throw new AppError("CONFLICT", "配置正在被其他操作修改。当前编辑内容已保留，请稍后重试。");
}
