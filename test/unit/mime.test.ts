import { describe, expect, it } from "vitest";
import { parseMime } from "../../src/adapters/upstreams/_shared/mime";

/**
 * 最小 MIME 解析器。存在的理由：cloudflare_temp_email 的 /admin/mails 只返回 raw，
 * 没有 subject/正文字段（summary_only 被上游忽略），网关必须自己解析才能在统一 API
 * 里输出归一化的 subject/text/html。
 */

const crlf = (lines: string[]) => lines.join("\r\n");

describe("parseMime", () => {
  it("纯文本邮件：主题、发件人、收件人、时间、正文", () => {
    const raw = crlf([
      "From: Sender Name <sender@example.org>",
      "To: user@inbox.test",
      "Subject: Your verification code",
      "Date: Tue, 01 Sep 2026 10:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your code is 123456.",
    ]);
    const p = parseMime(raw);
    expect(p.subject).toBe("Your verification code");
    expect(p.from).toBe("Sender Name <sender@example.org>");
    expect(p.to).toEqual(["user@inbox.test"]);
    expect(p.date?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(p.text).toContain("123456");
    expect(p.html).toBeUndefined();
    expect(p.attachments).toEqual([]);
  });

  it("multipart/alternative：同时取出 text 与 html", () => {
    const raw = crlf([
      "Subject: Both parts",
      'Content-Type: multipart/alternative; boundary="BND"',
      "",
      "--BND",
      "Content-Type: text/plain",
      "",
      "plain body",
      "--BND",
      "Content-Type: text/html",
      "",
      "<p>html body</p>",
      "--BND--",
    ]);
    const p = parseMime(raw);
    expect(p.text?.trim()).toBe("plain body");
    expect(p.html?.trim()).toBe("<p>html body</p>");
  });

  it("quoted-printable 正文与软换行", () => {
    const raw = crlf([
      "Subject: QP",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Hello=2C world=  ",
      "continued line",
    ]);
    const p = parseMime(raw);
    // =2C 解成逗号；行尾 = 是软换行（这里 "=  " 不是合法软换行，保持原样即可）
    expect(p.text).toContain("Hello, world");
  });

  it("base64 正文", () => {
    const body = Buffer.from("secret code 998877", "utf-8").toString("base64");
    const raw = crlf([
      "Subject: B64",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      body,
    ]);
    expect(parseMime(raw).text).toContain("998877");
  });

  it("RFC 2047 编码主题（base64 与 Q 编码，含中文）", () => {
    const zh = Buffer.from("验证码 6688", "utf-8").toString("base64");
    const b64 = parseMime(crlf([`Subject: =?utf-8?B?${zh}?=`, "", "x"]));
    expect(b64.subject).toBe("验证码 6688");

    const q = parseMime(crlf(["Subject: =?utf-8?Q?Hello_World=21?=", "", "x"]));
    expect(q.subject).toBe("Hello World!");
  });

  it("折行的长主题被拼回一行", () => {
    const raw = crlf([
      "Subject: a very long subject that",
      "  continues on the next line",
      "",
      "body",
    ]);
    expect(parseMime(raw).subject).toBe("a very long subject that continues on the next line");
  });

  it("附件：取出文件名、类型与大小，且不把附件当正文", () => {
    const data = Buffer.from("PDFDATA".repeat(10), "utf-8").toString("base64");
    const raw = crlf([
      "Subject: With attachment",
      'Content-Type: multipart/mixed; boundary="M"',
      "",
      "--M",
      "Content-Type: text/plain",
      "",
      "see attachment",
      "--M",
      "Content-Type: application/pdf; name=\"invoice.pdf\"",
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      data,
      "--M--",
    ]);
    const p = parseMime(raw);
    expect(p.text?.trim()).toBe("see attachment");
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0]).toMatchObject({ filename: "invoice.pdf", contentType: "application/pdf" });
    expect(p.attachments[0]!.size).toBeGreaterThan(0);
  });

  it("嵌套 multipart（mixed 里套 alternative）", () => {
    const raw = crlf([
      "Subject: Nested",
      'Content-Type: multipart/mixed; boundary="OUT"',
      "",
      "--OUT",
      'Content-Type: multipart/alternative; boundary="IN"',
      "",
      "--IN",
      "Content-Type: text/plain",
      "",
      "inner plain",
      "--IN",
      "Content-Type: text/html",
      "",
      "<b>inner html</b>",
      "--IN--",
      "--OUT--",
    ]);
    const p = parseMime(raw);
    expect(p.text?.trim()).toBe("inner plain");
    expect(p.html?.trim()).toBe("<b>inner html</b>");
  });

  it("多个收件人拆成数组并去掉显示名", () => {
    const p = parseMime(crlf(['To: "A" <a@x.test>, b@y.test', "", "x"]));
    expect(p.to).toEqual(["a@x.test", "b@y.test"]);
  });

  it("LF 换行（非 CRLF）同样能解析", () => {
    const p = parseMime("Subject: LF only\nContent-Type: text/plain\n\nbody here");
    expect(p.subject).toBe("LF only");
    expect(p.text?.trim()).toBe("body here");
  });

  it("畸形输入一律降级为空结果，绝不抛错（读信路径不能被一封坏邮件搞挂）", () => {
    for (const bad of ["", "   ", "no headers at all", "Subject:", "=?bogus?X?zz?="]) {
      expect(() => parseMime(bad)).not.toThrow();
    }
    expect(parseMime("").subject).toBe("");
    // 声明了 boundary 但没有任何分隔符：退化成单部件，不应崩
    const weird = parseMime('Content-Type: multipart/mixed; boundary="NOPE"\n\njust text');
    expect(weird.attachments).toEqual([]);
  });

  it("非字符串输入安全返回", () => {
    expect(parseMime(undefined as unknown as string).subject).toBe("");
    expect(parseMime(null as unknown as string).attachments).toEqual([]);
  });
});
