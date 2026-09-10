import { DummyUpstreamAdapter } from "../src/adapters/upstreams/dummy";
import type { GatewayDeps } from "../src/core/app";

/**
 * 测试专用：向 registry 注册内置假上游。
 * bootstrap 默认只注册真实上游适配器，内存态 Dummy 仅在测试里显式挂载。
 */
export function registerDummyAdapter(deps: GatewayDeps): DummyUpstreamAdapter {
  const dummy = new DummyUpstreamAdapter();
  deps.registry.register(dummy, {
    displayName: "Dummy（内置假上游）",
    description: "内存态假上游，用于联调与测试，不访问网络",
  });
  return dummy;
}
