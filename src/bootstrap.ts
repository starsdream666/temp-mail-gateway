import { CfTempEmailAdapter } from "./adapters/upstreams/cftempemail";
import { MoeMailAdapter } from "./adapters/upstreams/moemail";
import { YydsMailAdapter } from "./adapters/upstreams/yydsmail";
import { DuckMailAdapter } from "./adapters/upstreams/duckmail";
import { AdapterRegistry } from "./adapters/registry";
import { createApp, type GatewayDeps } from "./core/app";

/**
 * 公共组装逻辑：注册内置适配器集合（均为真实上游）。
 * 接入新真实上游时，在这里加一行 register 即可。
 */
export function buildDeps(partial: Omit<GatewayDeps, "registry">): GatewayDeps {
  const registry = new AdapterRegistry();
  registry.register(new CfTempEmailAdapter(), {
    displayName: "cloudflare_temp_email",
    description: "自建 cloudflare_temp_email 实例的管理端 API；apiKey 填实例管理员 token（x-admin-auth）",
  });
  registry.register(new MoeMailAdapter(), {
    displayName: "MoeMail",
    description: "自建 MoeMail 实例；apiKey 填 MoeMail API Key（X-API-Key），settings 可配 defaultExpiryMs",
  });
  registry.register(new YydsMailAdapter(), {
    displayName: "YYDS Mail",
    description: "YYDS Mail（vip.215.im）公开 API；apiKey 填 AC- 前缀 API Key，baseUrl 填实例根地址（自动补 /v1）",
  });
  registry.register(new DuckMailAdapter(), {
    displayName: "DuckMail",
    description: "DuckMail 公开 API；apiKey 可选（dk_ 前缀，私有域名需要），系统域名可匿名建箱",
  });
  return { ...partial, registry };
}
