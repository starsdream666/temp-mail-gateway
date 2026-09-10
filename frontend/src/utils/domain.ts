/**
 * 域名解析小工具：为筛选器提取顶级域（TLD）与主域（基础域名）。
 * 不追求公共后缀表（PSL）级别的精确度，面向筛选场景的实用近似：
 *   007.hzeg.eu.org → tld=org     主域=hzeg.eu.org（≥3 段时取「去掉首段」）
 *   020307.ccwu.cc  → tld=cc      主域=ccwu.cc（本身）
 *   1av1.lx1qzz.qzz.io → tld=io   主域=lx1qzz.qzz.io
 *   d25014.com      → tld=com     主域=d25014.com（本身）
 */

export function tldOf(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  return labels[labels.length - 1] ?? domain;
}

export function baseDomainOf(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  return labels.length > 2 ? labels.slice(1).join(".") : domain;
}

/** 域名层级（按段数）：2 段（a.com）= 顶级域名，3 段（a.b.com）= 二级域名，依此类推 */
export function domainLevelOf(domain: string): number {
  return domain.split(".").filter(Boolean).length;
}

/** 段数 → 层级名称（2 段 = 顶级域名，3 段 = 二级域名，…，5 段以上 = N级域名） */
export function levelNameForLabelCount(labels: number): string {
  const level = labels - 1;
  if (level <= 1) return "顶级域名";
  if (level === 2) return "二级域名";
  if (level === 3) return "三级域名";
  if (level === 4) return "四级域名";
  return `${level}级域名`;
}

export interface OptionWithCount {
  value: string;
  count: number;
}

/** 从域名集合提取某字段的去重选项（按数量降序、同数按字母序） */
export function collectOptions(domains: string[], pick: (d: string) => string): OptionWithCount[] {
  const counts = new Map<string, number>();
  for (const d of domains) {
    const key = pick(d);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
