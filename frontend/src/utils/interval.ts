/** 将秒统一转换为整数毫秒；容忍二进制浮点误差，但拒绝实际的亚毫秒值。 */
export function secondsToMilliseconds(value: string): number {
  if (!value.trim()) return NaN;
  const scaled = Number(value) * 1000;
  const rounded = Math.round(scaled);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled));
  return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) <= tolerance ? rounded : NaN;
}

export function parseIntervalSeconds(value: string, label: string): number {
  const milliseconds = secondsToMilliseconds(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 60_000 || milliseconds > 86_400_000) {
    throw new Error(`${label}请输入 60 至 86400 秒，精确到毫秒`);
  }
  return milliseconds;
}
