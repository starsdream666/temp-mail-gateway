import {
  type UpstreamAdapter,
  type UpstreamConfig,
  type CreateMailboxRequest,
  type MailboxRef,
  type DomainInfo,
  type MessageSummary,
  type MessageDetail,
  type UpstreamAdapterDeps,
  type PassthroughInspectInput,
  type PassthroughObservation,
  UpstreamError,
} from "../../../ports/upstream";
import {
  type UpstreamHttpDeps,
  requireApiKey,
  stripTrailingSlash,
  upstreamGetJson,
  upstreamSend,
  filterAfterCursor,
  randomLocalPart,
  parseUpstreamDate,
} from "../_shared/http";
import { parseMime } from "../_shared/mime";

/**
 * cloudflare_temp_email（dreamhunter2333/cloudflare_temp_email）管理端 API 适配器。
 *
 * 权威事实以用户实例 v1.9.0 实测 + 参考项目源码（worker 1.12.0）为准，不要凭记忆：
 *   GET  /open_api/settings                 → 公开；含 domains / defaultDomains /
 *                                            randomSubdomainDomains / domainLabels（按下标对齐 domains）
 *   POST /admin/new_address { name, domain } → { address, jwt, address_id }
 *                                            name 先按 ADDRESS_REGEX（默认 [^a-z0-9]）删字符
 *   GET  /admin/mails?address=&limit=&offset= → { results, count }；limit 必填且 ∈ 1..100；
 *                                            summary_only 被忽略；行里只有 raw，没有 subject/message
 *   GET  /admin/mails/{id}                  → **v1.9.0 没有此路由（404）**；1.12.0 源码有，
 *                                            但不按 address 过滤（id 全局自增，可跨邮箱读信）
 *   DELETE /admin/mails/{id}                → 删单封；D1 success 只表示语句执行了
 *   GET  /admin/address?query=&limit=&offset= → 地址簿；query 是 LIKE %q% / 超长改 instr；模糊匹配
 *   DELETE /admin/delete_address/{id}       → 删邮箱（只要内部数字 id）
 *
 * settings.sitePassword → x-custom-auth（实例配了 PASSWORDS 时的前置站点密码）。
 * apiKey 必填 = x-admin-auth。
 */

interface CfMailRow {
  id: number | string;
  address?: string;
  source?: string;
  subject?: string;
  message?: string;
  raw?: string;
  created_at?: string | number;
}

interface CfAddressRecord {
  id: number | string;
  name?: string;
  domain?: string;
  address?: string;
  email?: string;
}

/** 地址簿查找的分页参数（删除邮箱要先拿上游内部 id） */
const ADDRESS_LOOKUP_PAGE_SIZE = 50;
const ADDRESS_LOOKUP_MAX_PAGES = 10;

/**
 * 邮件列表分页：上游强制 limit ∈ 1..100（超出 400），offset 分页。
 * 取 100/页 把请求数压到最少；20 页 = 2000 封，够任何临时邮箱。
 */
const MAIL_PAGE_SIZE = 100;
const MAIL_LOOKUP_MAX_PAGES = 20;

export class CfTempEmailAdapter implements UpstreamAdapter {
  readonly type = "cf-temp-email";

  private readonly deps: UpstreamHttpDeps;

  constructor(deps: UpstreamAdapterDeps = {}) {
    this.deps = {
      fetchFn: deps.fetchFn ?? ((input, init) => fetch(input as never, init)),
      logger: deps.logger,
    };
  }

  async listDomains(cfg: UpstreamConfig): Promise<DomainInfo[]> {
    const base = stripTrailingSlash(cfg.baseUrl);
    const data = await upstreamGetJson<{ domains?: unknown; defaultDomains?: unknown }>(
      this.deps, cfg, `${base}/open_api/settings`, {}, "/open_api/settings",
    );
    const raw = Array.isArray(data.domains) ? data.domains : Array.isArray(data.defaultDomains) ? data.defaultDomains : [];
    return raw
      .map((d) => (typeof d === "string" ? d.trim() : ""))
      .filter((d): d is string => d.length > 0)
      .map((domain) => ({ domain: domain.toLowerCase() }));
  }

  async createMailbox(cfg: UpstreamConfig, req: CreateMailboxRequest): Promise<MailboxRef> {
    const base = stripTrailingSlash(cfg.baseUrl);
    const res = await upstreamSend(
      this.deps, cfg, `${base}/admin/new_address`, "POST",
      this.adminHeaders(cfg),
      { name: req.localPart ?? randomLocalPart(), domain: req.domain },
      "/admin/new_address",
    );
    const data = (await res.json().catch(() => ({}))) as {
      address?: string;
      jwt?: string;
      address_id?: number | string;
    };
    // 地址必须取响应值：上游会按 [^a-z0-9] 删字符改写 localPart
    // （实测 gwlive-cf-01 → gwlivecf01，大写字母同样被删掉）。
    // 自己拼 `${localPart}@${domain}` 会登记一个上游不存在的地址，
    // 之后收信恒空、删除恒 404 —— 所以缺字段时宁可失败。
    const address = data.address;
    if (!address) {
      throw new UpstreamError("UNKNOWN", cfg.id, {
        message: "上游 /admin/new_address 响应缺少 address 字段",
      });
    }
    return {
      upstreamMailboxId: address,
      address,
      // 响应同时给了 address_id（删除接口要的内部 id）与 jwt（每邮箱凭证）。
      // 一并存进 credentials，删除时就不必再翻地址簿去反查 id。
      credentials: packCfCredentials({ jwt: data.jwt, addressId: data.address_id }),
      expiresAt: req.expiresInSeconds ? new Date(Date.now() + req.expiresInSeconds * 1000) : undefined,
    };
  }

  async deleteMailbox(cfg: UpstreamConfig, ref: MailboxRef): Promise<void> {
    const token = requireApiKey(cfg, "x-admin-auth token");
    const base = stripTrailingSlash(cfg.baseUrl);
    // 上游删除只接受内部记录 id，必须先按地址查出来。地址簿可能极大且 query 语义随
    // 实例而异（前缀/模糊匹配都见过），所以分页扫描而不是只看第一页；找不到就抛
    // NOT_FOUND，由网关决定「当作已删除」还是「如实回报上游可能仍保留」——
    // 早期实现在这里直接 return，等于上游还在却回报删除成功，静默制造孤儿。
    // 建箱时若已存下 address_id（v1.9.0 的 new_address 响应带它），直接用，
    // 省掉整个地址簿扫描——那个扫描在同域名邮箱多时会翻到 500 行上限而误报未找到。
    const storedId = readStoredAddressId(ref.credentials);
    const addressId = storedId ?? (await this.findAddressRecord(cfg, base, token, ref.address))?.id;
    if (addressId === undefined || addressId === null) {
      throw new UpstreamError("NOT_FOUND", cfg.id, {
        message: `上游地址簿中未找到 ${ref.address}（可能已删除，或该实例的 query 未命中）`,
      });
    }
    await upstreamSend(
      this.deps, cfg, `${base}/admin/delete_address/${addressId}`, "DELETE",
      this.adminHeaders(cfg), undefined, "/admin/delete_address",
    );
  }

  /**
   * 纳管：地址簿里能查到即视为上游存在该邮箱。
   * cf 的 upstreamMailboxId 就是地址本身（见 createMailbox），所以无需额外映射；
   * 收信走 /admin/mails?address=，用的是实例级 admin token，不需要每邮箱凭证。
   */
  async resolveByAddress(cfg: UpstreamConfig, address: string): Promise<MailboxRef> {
    const token = requireApiKey(cfg, "x-admin-auth token");
    const base = stripTrailingSlash(cfg.baseUrl);
    const normalized = address.trim().toLowerCase();
    const match = await this.findAddressRecord(cfg, base, token, normalized);
    if (!match) {
      throw new UpstreamError("NOT_FOUND", cfg.id, {
        message: `上游地址簿中不存在 ${normalized}`,
      });
    }
    const resolved = addressOf(match) || normalized;
    return {
      upstreamMailboxId: resolved,
      address: resolved,
      // 纳管时把内部 id 一并记下，之后删除不必再扫地址簿
      credentials: packCfCredentials({ addressId: match.id }),
    };
  }

  /** 按地址在上游地址簿里分页查找记录（供删除取内部 id） */
  private async findAddressRecord(
    cfg: UpstreamConfig,
    base: string,
    token: string,
    address: string,
  ): Promise<CfAddressRecord | null> {
    const wanted = address.toLowerCase();
    for (let page = 0; page < ADDRESS_LOOKUP_MAX_PAGES; page += 1) {
      const offset = page * ADDRESS_LOOKUP_PAGE_SIZE;
      const data = await upstreamGetJson<{ results?: CfAddressRecord[] }>(
        this.deps, cfg,
        `${base}/admin/address?query=${encodeURIComponent(address)}&limit=${ADDRESS_LOOKUP_PAGE_SIZE}&offset=${offset}`,
        this.adminHeaders(cfg),
        "/admin/address",
      );
      const results = data.results ?? [];
      const hit = results.find((r) => addressOf(r) === wanted);
      if (hit) return hit;
      // 最后一页（返回不足一页）说明查询结果已穷尽
      if (results.length < ADDRESS_LOOKUP_PAGE_SIZE) return null;
    }
    return null;
  }

  async listMessages(
    cfg: UpstreamConfig,
    ref: MailboxRef,
    opts?: { since?: string },
  ): Promise<MessageSummary[]> {
    const rows = await this.fetchMailRows(cfg, ref);
    const summaries = rows.map((row) => this.toSummary(cfg, ref, row)).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    return filterAfterCursor(summaries, opts?.since);
  }

  async getMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<MessageDetail> {
    const row = await this.fetchMail(cfg, ref, messageId);
    const parsed = parseMime(row.raw ?? "");
    return {
      ...this.toSummary(cfg, ref, row),
      // 上游只给 raw，subject/正文/附件全靠本地解析（见 fetchMailRows 的说明）
      text: parsed.text ?? undefined,
      html: parsed.html ? [parsed.html] : [],
      attachments: parsed.attachments.map((a, i) => ({
        // 上游不提供附件 ID（附件内容需 S3 开启后才有独立端点），
        // 这里用序号占位，仅供调用方展示元数据
        id: String(i),
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
    };
  }

  async deleteMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<void> {
    const base = stripTrailingSlash(cfg.baseUrl);
    // 归属校验：上游 DELETE /admin/mails/{id} 不按 address 过滤，且 D1 的 success
    // 只表示「语句执行了」——删不存在或别人的邮件同样返回 success:true。
    // 先确认这封信确实属于本邮箱，否则会跨邮箱删信并谎报成功。
    await this.fetchMail(cfg, ref, messageId);
    await upstreamSend(
      this.deps, cfg, `${base}/admin/mails/${encodeURIComponent(messageId)}`, "DELETE",
      this.adminHeaders(cfg), undefined, "/admin/mails",
    );
  }

  async getSource(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<Uint8Array> {
    const row = await this.fetchMail(cfg, ref, messageId);
    return new TextEncoder().encode(row.raw ?? "");
  }

  authHeaders(cfg: UpstreamConfig): Record<string, string> {
    return this.adminHeaders(cfg);
  }

  /**
   * 管理端请求头。除了 `x-admin-auth`，实例若配置了 PASSWORDS（站点访问密码），
   * worker 会有一道**前置**全局中间件拦掉除 /open_api 与 /telegram 之外的所有请求，
   * 缺 `x-custom-auth` 直接 401 —— 此时 x-admin-auth 再对也没用。
   * 失败形态很误导：/open_api/settings 是豁免的，所以域名同步照样成功、渠道看着健康，
   * 而建箱/收信/删除全 401。用 settings.sitePassword 配置该密码。
   * （用户当前实例 needAuth=false，不需要配；此项是为设了密码的实例准备的。）
   */
  private adminHeaders(cfg: UpstreamConfig): Record<string, string> {
    const token = requireApiKey(cfg, "x-admin-auth token");
    const headers: Record<string, string> = { "x-admin-auth": token };
    const sitePassword = cfg.settings.sitePassword;
    if (typeof sitePassword === "string" && sitePassword.trim()) {
      headers["x-custom-auth"] = sitePassword.trim();
    }
    return headers;
  }

  /**
   * 透传副作用观察：POST /admin/new_address 2xx → 登记。
   * 删除接口 /admin/delete_address/{上游记录ID} 只含上游内部 ID，无法映射回
   * 网关注册表 → 不观察（该场景由管理端手动清理或统一 API 删除兜底）。
   */
  inspectPassthrough(input: PassthroughInspectInput): PassthroughObservation | null {
    if (input.status < 200 || input.status >= 300) return null;
    if (input.method !== "POST" || input.path !== "/admin/new_address") return null;
    try {
      const body = JSON.parse(input.responseBodyText ?? "{}") as {
        address?: string;
        jwt?: string;
        address_id?: number | string;
      };
      if (!body.address) return null;
      return {
        action: "created",
        ref: {
          upstreamMailboxId: body.address,
          address: body.address,
          // 必须跟 createMailbox 同一形状：JSON {jwt, addressId}。
          // 早先只存裸 jwt 字符串，透传建的箱删除时只能回退扫地址簿，
          // 同域名邮箱一多就会翻到扫描上限而误报未找到。
          credentials: packCfCredentials({ jwt: body.jwt, addressId: body.address_id }),
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * 透传列表过滤：GET /open_api/settings → { domains: string[], ... }（公开端点，
   * floatmail Temp 渠道域名下拉的来源），按可用域名改写域名类数组。注意真实的
   * settings（v1.9.0 实测）里域名类数组不止 domains/defaultDomains，还有
   * randomSubdomainDomains，以及跟 domains 按下标一一对应的 domainLabels——
   * 这两者也必须处理，否则透传客户端看到的内容与网关的隔离意图不符（见方法内注释）。
   */
  filterPassthroughList(input: {
    path: string;
    responseBodyText: string;
    isDomainAllowed: (domain: string) => boolean;
  }): string | null {
    if (input.path !== "/open_api/settings") return null;
    try {
      const parsed: unknown = JSON.parse(input.responseBodyText);
      if (!parsed || typeof parsed !== "object") return null;
      const settings = { ...(parsed as Record<string, unknown>) };
      // 判定沿用原语义：只剔除「明确是字符串且判定为不可用」的项，异常形状原样放行。
      const isAllowedEntry = (d: unknown): boolean =>
        typeof d !== "string" || !d.trim() || input.isDomainAllowed(d.trim().toLowerCase());
      // 三个数组同义（/admin/new_address 对它们一视同仁），全按可用域名裁剪；
      // randomSubdomainDomains 不剪的话，原生透传客户端仍能看到本应隐藏的域名。
      // 先留一份原始 domains：domainLabels 与它按下标对应，裁剪要按同一批下标走。
      const rawDomains = settings["domains"];
      let touched = false;
      for (const key of ["domains", "defaultDomains", "randomSubdomainDomains"]) {
        const raw = settings[key];
        if (!Array.isArray(raw)) continue;
        settings[key] = raw.filter(isAllowedEntry);
        touched = true;
      }
      // domainLabels 是 domains 的「位置对应」显示名（官方前端按 index 把它们 zip
      // 成下拉项），只剪 domains 会让被删项之后的标签整体前移错位——例如 domains=
      // [a,b,c] 只留 b 时若不动 labels，c 的标签会顶到 b 的位置，客户端渲染全错。
      // 因此按「保留的下标」同步裁剪 labels；仅在 labels 与原始 domains 等长时才
      // 存在确定的对应关系，对不上（实例没配齐 DOMAIN_LABELS 之类）就不去猜、原样透传。
      const rawLabels = settings["domainLabels"];
      if (
        Array.isArray(rawDomains) &&
        Array.isArray(rawLabels) &&
        rawLabels.length === rawDomains.length
      ) {
        const keptLabels: unknown[] = [];
        rawDomains.forEach((d, i) => {
          if (isAllowedEntry(d)) keptLabels.push(rawLabels[i]);
        });
        settings["domainLabels"] = keptLabels;
      }
      return touched ? JSON.stringify(settings) : null;
    } catch {
      return null;
    }
  }

  // ---------- internals ----------

  /**
   * 拉取该地址的全部邮件行（按 offset 翻页）。
   *
   * 上游 `/admin/mails` 的约束（v1.9.0 源码 + 实测）：
   *   - `limit` 必填且必须在 1..100，超出直接 400（所以不能简单调大）；
   *   - 是 offset 分页、默认 `id desc`（新→旧）；
   *   - `count` 只在 offset=0 时有值，之后恒为 0，不能当总数用；
   *   - **`summary_only=true` 被忽略**，响应恒含 `raw`、且没有 subject/message 字段。
   * 早先只发一次 limit=50 就当成整个收件箱，超过 50 封时更早的信永久不可见，
   * 且 since 游标落在窗口外会让 filterAfterCursor 整窗重放。
   */
  private async fetchMailRows(cfg: UpstreamConfig, ref: MailboxRef): Promise<CfMailRow[]> {
    const base = stripTrailingSlash(cfg.baseUrl);
    const rows: CfMailRow[] = [];
    for (let page = 0; page < MAIL_LOOKUP_MAX_PAGES; page += 1) {
      const offset = page * MAIL_PAGE_SIZE;
      const data = await upstreamGetJson<{ results?: CfMailRow[] }>(
        this.deps, cfg,
        `${base}/admin/mails?address=${encodeURIComponent(ref.address)}&limit=${MAIL_PAGE_SIZE}&offset=${offset}`,
        this.adminHeaders(cfg),
        "/admin/mails",
      );
      const batch = data.results ?? [];
      rows.push(...batch);
      if (batch.length < MAIL_PAGE_SIZE) break;
    }
    return rows;
  }

  /**
   * 取单封。**不能用 `/admin/mails/{id}`** —— 该路由在 v1.9.0 上不存在（实测 404），
   * 且即使存在也不按 address 过滤（id 是全局自增，可跨邮箱读别人的信）。
   * 因此改为在本地址的列表里按 id 找：既天然完成归属校验，也在各版本上都可用。
   */
  private async fetchMail(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<CfMailRow> {
    const rows = await this.fetchMailRows(cfg, ref);
    const hit = rows.find((row) => String(row.id) === String(messageId));
    if (!hit) {
      throw new UpstreamError("NOT_FOUND", cfg.id, {
        message: `邮箱 ${ref.address} 下不存在消息 ${messageId}`,
      });
    }
    return hit;
  }

  private toSummary(cfg: UpstreamConfig, ref: MailboxRef, row: CfMailRow): MessageSummary {
    // 上游行里没有 subject/正文，只有 raw；解析它才能给出可读的摘要
    const parsed = parseMime(row.raw ?? "");
    const intro = parsed.text || stripHtml(parsed.html ?? "");
    return {
      id: String(row.id),
      from: parsed.from || row.source || "",
      to: parsed.to.length > 0 ? parsed.to : [ref.address],
      subject: parsed.subject,
      intro: intro ? intro.slice(0, 128) : undefined,
      seen: false,
      hasAttachments: parsed.attachments.length > 0,
      createdAt: parsed.date ?? parseUpstreamDate(row.created_at),
    };
  }
}

/**
 * credentials 统一成 JSON `{jwt?, addressId?}`。缺字段时仍写出对象，
 * 读侧按字段取；空对象不写（避免把「无凭证」伪装成有凭证）。
 * 兼容旧数据：早期版本存的是裸 jwt 字符串，readStoredAddressId 会识别并回退扫地址簿。
 */
function packCfCredentials(parts: { jwt?: string; addressId?: number | string }): string | undefined {
  const out: { jwt?: string; addressId?: number | string } = {};
  if (typeof parts.jwt === "string" && parts.jwt.length > 0) out.jwt = parts.jwt;
  if (parts.addressId !== undefined && parts.addressId !== null && String(parts.addressId).length > 0) {
    out.addressId = parts.addressId;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : undefined;
}

/**
 * 从 ref.credentials 里取建箱时存下的上游内部 address_id。
 * 兼容旧数据：早期版本这里存的是裸 jwt 字符串（不是 JSON），此时返回 undefined
 * 回退到地址簿扫描，不能因为解析失败就让删除整个失败。
 */
function readStoredAddressId(credentials: string | undefined): number | string | undefined {
  if (!credentials || !credentials.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(credentials) as { addressId?: number | string };
    return parsed.addressId ?? undefined;
  } catch {
    return undefined;
  }
}

/** 粗略去标签，仅用于生成摘要（intro），不用于渲染 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addressOf(record: CfAddressRecord): string {
  if (record.address) return String(record.address).trim().toLowerCase();
  if (record.name && record.domain) return `${record.name}@${record.domain}`.toLowerCase();
  return String(record.name ?? "").trim().toLowerCase();
}
