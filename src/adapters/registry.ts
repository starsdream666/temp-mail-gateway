import type { AdapterMeta, UpstreamAdapter } from "../ports/upstream";

interface RegisteredAdapter {
  adapter: UpstreamAdapter;
  meta: AdapterMeta;
}

/**
 * 适配器注册表：type 字符串 → 适配器实例。
 * 接入新上游 = 写一个 UpstreamAdapter + 在 entries 里注册一行。
 */
export class AdapterRegistry {
  private byType = new Map<string, RegisteredAdapter>();

  register(adapter: UpstreamAdapter, meta: Omit<AdapterMeta, "type" | "capabilities">): void {
    this.byType.set(adapter.type, {
      adapter,
      meta: {
        type: adapter.type,
        displayName: meta.displayName,
        description: meta.description,
        capabilities: {
          deleteMessage: typeof adapter.deleteMessage === "function",
          getSource: typeof adapter.getSource === "function",
        },
      },
    });
  }

  get(type: string): UpstreamAdapter {
    const hit = this.byType.get(type);
    if (!hit) {
      throw new Error(`未注册的适配器类型: ${type}（该上游未接入网关）`);
    }
    return hit.adapter;
  }

  has(type: string): boolean {
    return this.byType.has(type);
  }

  listMetas(): AdapterMeta[] {
    return [...this.byType.values()].map((r) => r.meta);
  }
}
