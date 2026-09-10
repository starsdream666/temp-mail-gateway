import {
  type UpstreamAdapter,
  type UpstreamConfig,
  type CreateMailboxRequest,
  type MailboxRef,
  type DomainInfo,
  type MessageSummary,
  type MessageDetail,
  type UpstreamErrorCode,
  UpstreamError,
} from "../../../ports/upstream";

/**
 * Dummy 适配器 —— 全内存实现，用于壳子期的端到端联调与契约测试，不访问网络。
 * settings.domains 可自定义可用域名（默认 dummy.test / inbox.dummy.dev）。
 *
 * 测试投递消息：拿到 adapter 实例后调用 deliver()（仅内存，无需经过上游 API 语义）。
 */

interface DummyMailbox {
  ref: MailboxRef;
  messages: Map<string, DummyMessage>;
  createdAt: number;
}

interface DummyMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  seen: boolean;
  createdAt: number;
}

const DEFAULT_DOMAINS = ["dummy.test", "inbox.dummy.dev"];

export class DummyUpstreamAdapter implements UpstreamAdapter {
  readonly type = "dummy";

  /** 测试钩子：模拟「邮箱操作依赖每邮箱独立凭证」的上游（如 DuckMail），影响尽力删除策略 */
  requiresMailboxCredentials = false;

  /** cfgId → mailboxes；按上游实例隔离 */
  private state = new Map<string, Map<string, DummyMailbox>>();
  private seq = 0;
  /** 测试钩子：非 null 时 deleteMailbox 抛出该上游错误码 */
  private deleteFailure: UpstreamErrorCode | null = null;

  private mailboxesFor(cfg: UpstreamConfig): Map<string, DummyMailbox> {
    let m = this.state.get(cfg.id);
    if (!m) {
      m = new Map();
      this.state.set(cfg.id, m);
    }
    return m;
  }

  private requireMailbox(cfg: UpstreamConfig, mailboxId: string): DummyMailbox {
    const box = this.mailboxesFor(cfg).get(mailboxId);
    if (!box) {
      throw new UpstreamError("NOT_FOUND", cfg.id, { message: `dummy 上游不存在邮箱 ${mailboxId}` });
    }
    return box;
  }

  async listDomains(cfg: UpstreamConfig): Promise<DomainInfo[]> {
    const domains = cfg.settings.domains;
    const list = Array.isArray(domains) && domains.length > 0 ? (domains as string[]) : DEFAULT_DOMAINS;
    return list.map((domain) => ({ domain }));
  }

  async createMailbox(cfg: UpstreamConfig, req: CreateMailboxRequest): Promise<MailboxRef> {
    const mailboxes = this.mailboxesFor(cfg);
    const localPart = req.localPart ?? `user${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const address = `${localPart}@${req.domain}`;

    for (const box of mailboxes.values()) {
      if (box.ref.address === address) {
        throw new UpstreamError("BAD_REQUEST", cfg.id, { message: `local part 已被占用: ${localPart}` });
      }
    }

    const ref: MailboxRef = {
      upstreamMailboxId: `dm_${address}`,
      address,
      credentials: `dummy-jwt-${address}`,
      password: req.password ?? undefined,
    };
    mailboxes.set(ref.upstreamMailboxId, { ref, messages: new Map(), createdAt: Date.now() });
    return ref;
  }

  /** 纳管：按地址在本实例的内存邮箱里反查（模拟账号级凭证的上游） */
  async resolveByAddress(cfg: UpstreamConfig, address: string): Promise<MailboxRef> {
    const wanted = address.trim().toLowerCase();
    for (const box of this.mailboxesFor(cfg).values()) {
      if (box.ref.address.toLowerCase() === wanted) return box.ref;
    }
    throw new UpstreamError("NOT_FOUND", cfg.id, { message: `dummy 上游不存在地址 ${wanted}` });
  }

  async deleteMailbox(cfg: UpstreamConfig, ref: MailboxRef): Promise<void> {
    if (this.deleteFailure) {
      throw new UpstreamError(this.deleteFailure, cfg.id, {
        message: `dummy 上游删除失败（注入的测试故障：${this.deleteFailure}）`,
      });
    }
    this.mailboxesFor(cfg).delete(ref.upstreamMailboxId);
  }

  async listMessages(cfg: UpstreamConfig, ref: MailboxRef, opts?: { since?: string }): Promise<MessageSummary[]> {
    const box = this.requireMailbox(cfg, ref.upstreamMailboxId);
    const all = [...box.messages.values()].sort((a, b) => a.createdAt - b.createdAt);
    const sinceIdx = opts?.since ? all.findIndex((m) => m.id === opts.since) : -1;
    const slice = sinceIdx >= 0 ? all.slice(sinceIdx + 1) : all;
    return slice.map(toSummary);
  }

  async getMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<MessageDetail> {
    const box = this.requireMailbox(cfg, ref.upstreamMailboxId);
    const msg = box.messages.get(messageId);
    if (!msg) {
      throw new UpstreamError("NOT_FOUND", cfg.id, { message: `消息不存在: ${messageId}` });
    }
    msg.seen = true;
    return {
      ...toSummary(msg),
      text: msg.text,
      html: [`<p>${msg.text}</p>`],
      attachments: [],
    };
  }

  async deleteMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<void> {
    const box = this.requireMailbox(cfg, ref.upstreamMailboxId);
    box.messages.delete(messageId);
  }

  async getSource(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<Uint8Array> {
    const box = this.requireMailbox(cfg, ref.upstreamMailboxId);
    const msg = box.messages.get(messageId);
    if (!msg) {
      throw new UpstreamError("NOT_FOUND", cfg.id, { message: `消息不存在: ${messageId}` });
    }
    const raw = [
      `From: ${msg.from}`,
      `To: ${msg.to.join(", ")}`,
      `Subject: ${msg.subject}`,
      `Date: ${new Date(msg.createdAt).toUTCString()}`,
      "",
      msg.text,
    ].join("\r\n");
    return new TextEncoder().encode(raw);
  }

  /** 测试钩子：向上游内存邮箱投递一封假邮件，返回消息 ID */
  deliver(cfg: UpstreamConfig, mailboxId: string, input: { from: string; subject: string; text: string }): string {
    const box = this.requireMailbox(cfg, mailboxId);
    const id = `msg_${++this.seq}`;
    box.messages.set(id, {
      id,
      from: input.from,
      to: [box.ref.address],
      subject: input.subject,
      text: input.text,
      seen: false,
      createdAt: Date.now(),
    });
    return id;
  }

  /** 测试钩子：注入 deleteMailbox 故障（传 null 恢复正常） */
  failDeleteMailbox(code: UpstreamErrorCode | null): void {
    this.deleteFailure = code;
  }

  /**
   * 测试钩子：模拟「不支持地址纳管」的上游（如 DuckMail）。
   * 网关按 `typeof adapter.resolveByAddress === "function"` 判定能力，
   * 所以这里真的把方法删掉，而不是让它抛错——判定路径要走到同一个分支。
   */
  hideResolveByAddress(hidden: boolean): void {
    if (hidden) {
      (this as { resolveByAddress?: unknown }).resolveByAddress = undefined;
    } else if (this.resolveByAddress === undefined) {
      delete (this as { resolveByAddress?: unknown }).resolveByAddress;
    }
  }

  /** 测试钩子：清空某个上游实例的内存状态（不带参数时同时复位注入的故障与凭证标记） */
  reset(cfgId?: string): void {
    if (cfgId) {
      this.state.delete(cfgId);
      return;
    }
    this.state.clear();
    this.deleteFailure = null;
    this.requiresMailboxCredentials = false;
    this.hideResolveByAddress(false);
  }
}

function toSummary(m: DummyMessage): MessageSummary {
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    subject: m.subject,
    intro: m.text.slice(0, 128),
    seen: m.seen,
    hasAttachments: false,
    createdAt: new Date(m.createdAt),
  };
}
