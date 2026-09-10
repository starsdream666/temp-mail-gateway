/**
 * 最小 MIME 解析器：从 RFC822 原文里取出主题、正文（text/html）与附件元数据。
 *
 * 为什么需要它：cloudflare_temp_email 的 `/admin/mails` 只返回 `raw`（原始报文），
 * 没有 subject/正文字段——`summary_only=true` 也被上游忽略（v1.9.0 实测两次响应一致）。
 * 官方前端同样是拿 raw 到客户端解析。网关要在统一 API 里输出归一化的
 * subject/text/html，就必须自己解析。
 *
 * 刻意保持"够用"而非完备：只处理临时邮箱场景真正会遇到的形态
 * （单层或嵌套 multipart、base64 / quoted-printable、RFC 2047 编码头）。
 * 不做签名校验、不解 TNEF、不递归 message/rfc822 内嵌邮件的正文。
 * 解析失败一律降级为"空正文 + 原文可取"，绝不抛错——读信路径不能因为
 * 一封畸形邮件整个失败。
 */

export interface ParsedMime {
  subject: string;
  from: string;
  to: string[];
  date: Date | null;
  text?: string;
  html?: string;
  attachments: { filename: string; contentType: string; size: number }[];
}

interface MimePart {
  headers: Map<string, string>;
  body: string;
}

/** 解析原始报文；任何异常都降级为空结果，不抛错 */
export function parseMime(raw: string): ParsedMime {
  const empty: ParsedMime = { subject: "", from: "", to: [], date: null, attachments: [] };
  if (!raw || typeof raw !== "string") return empty;

  try {
    const root = splitHeadersAndBody(raw);
    const result: ParsedMime = {
      subject: decodeHeaderValue(root.headers.get("subject") ?? ""),
      from: decodeHeaderValue(root.headers.get("from") ?? ""),
      to: splitAddressList(decodeHeaderValue(root.headers.get("to") ?? "")),
      date: parseHeaderDate(root.headers.get("date")),
      attachments: [],
    };

    const parts = flattenParts(root, 0);
    for (const part of parts) {
      const contentType = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
      const disposition = (part.headers.get("content-disposition") ?? "").toLowerCase();
      const decoded = decodeBody(part);

      // 有 filename 的部件按附件计（inline 图片也算——调用方只看元数据）
      const filename = extractParam(disposition, "filename") ?? extractParam(contentType, "name");
      if (filename || disposition.startsWith("attachment")) {
        result.attachments.push({
          filename: filename ?? "(未命名附件)",
          contentType: contentType.split(";")[0]!.trim(),
          size: decoded.length,
        });
        continue;
      }

      if (contentType.startsWith("text/html")) {
        if (result.html === undefined) result.html = decoded;
      } else if (contentType.startsWith("text/plain")) {
        if (result.text === undefined) result.text = decoded;
      }
    }

    return result;
  } catch {
    return empty;
  }
}

/** 以首个空行切分头部与正文；兼容 CRLF 与 LF */
function splitHeadersAndBody(raw: string): MimePart {
  const normalized = raw.replace(/\r\n/g, "\n");
  const sep = normalized.indexOf("\n\n");
  const headerBlock = sep >= 0 ? normalized.slice(0, sep) : normalized;
  const body = sep >= 0 ? normalized.slice(sep + 2) : "";
  return { headers: parseHeaders(headerBlock), body };
}

/** 解析头部；折行（下一行以空白开头）拼回同一个头 */
function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = block.split("\n");
  let current = "";
  const flush = () => {
    if (!current) return;
    const idx = current.indexOf(":");
    if (idx > 0) {
      const name = current.slice(0, idx).trim().toLowerCase();
      const value = current.slice(idx + 1).trim();
      // 同名头只保留首个（Received 之类重复头对我们无意义）
      if (!headers.has(name)) headers.set(name, value);
    }
    current = "";
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      current += " " + line.trim();
      continue;
    }
    flush();
    current = line;
  }
  flush();
  return headers;
}

/** 展开 multipart 为叶子部件列表；限制递归深度防畸形邮件打爆栈 */
function flattenParts(part: MimePart, depth: number): MimePart[] {
  if (depth > 8) return [part];
  const contentType = part.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/")) return [part];

  const boundary = extractParam(contentType, "boundary");
  if (!boundary) return [part];

  const marker = `--${boundary}`;
  const segments = part.body.split(marker);
  const out: MimePart[] = [];
  // 首段是 preamble、末段是 epilogue（以 -- 结尾），都跳过
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("--")) break;
    const trimmed = segment.replace(/^\n/, "");
    if (!trimmed.trim()) continue;
    out.push(...flattenParts(splitHeadersAndBody(trimmed), depth + 1));
  }
  return out.length > 0 ? out : [part];
}

/** 按 Content-Transfer-Encoding 解码正文 */
function decodeBody(part: MimePart): string {
  const encoding = (part.headers.get("content-transfer-encoding") ?? "").trim().toLowerCase();
  const charset = extractParam(part.headers.get("content-type") ?? "", "charset");
  if (encoding === "base64") return decodeBase64(part.body.replace(/\s+/g, ""), charset);
  if (encoding === "quoted-printable") return decodeQuotedPrintable(part.body, charset);
  return part.body;
}

function decodeBase64(data: string, charset?: string): string {
  try {
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    return decodeBytes(bytes, charset);
  } catch {
    return "";
  }
}

function decodeQuotedPrintable(data: string, charset?: string): string {
  // 先去掉软换行（行尾 =），再把 =XX 还原成字节
  const joined = data.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined[i]!;
    if (ch === "=" && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return decodeBytes(new Uint8Array(bytes), charset);
}

/** 按 charset 解字节；未知编码退回 UTF-8（TextDecoder 在 Workers 与 Node 都可用） */
function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const label = (charset ?? "utf-8").toLowerCase().replace(/["']/g, "");
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    try {
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return "";
    }
  }
}

/** 取 `name="value"` 或 `name=value` 形式的参数 */
function extractParam(headerValue: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|([^;\\s]+))`, "i");
  const m = re.exec(headerValue);
  if (!m) return undefined;
  return (m[2] ?? m[3] ?? "").trim() || undefined;
}

/**
 * 解 RFC 2047 编码头（=?utf-8?B?...?= / =?gbk?Q?...?=）。
 * 相邻编码块之间的空白按规范应当丢弃，否则中文主题会多出空格。
 */
function decodeHeaderValue(value: string): string {
  if (!value) return "";
  const decoded = value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s*)(?==\?|$|[^\s])/g,
    (_all, charset: string, kind: string, data: string) => {
      const isBase64 = kind.toLowerCase() === "b";
      return isBase64
        ? decodeBase64(data.replace(/\s+/g, ""), charset)
        : decodeQuotedPrintable(data.replace(/_/g, " "), charset);
    },
  );
  return decoded.trim();
}

/** 从 `Name <a@b>` 里取地址；多个用逗号分隔 */
function splitAddressList(value: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => {
      const angle = /<([^>]+)>/.exec(entry);
      return (angle ? angle[1]! : entry).trim();
    })
    .filter((a) => a.length > 0);
}

function parseHeaderDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}
