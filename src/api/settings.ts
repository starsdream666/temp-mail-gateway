import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "./env";
import type { AdminDeps } from "./admin";
import { ErrorEnvelope } from "./schemas";
import { AppError } from "../core/errors";
import { hashAdminPassword } from "../core/passwords";
import { publicSettings, readSettings, MIN_MAILBOX_CLEANUP_INTERVAL_MS, MAX_MAILBOX_CLEANUP_INTERVAL_MS, type SettingsPatch } from "../core/settings";
import { checkAdminPassword, currentAdminConfig, clearAdminSession } from "./middleware/auth";

const GlobalSettingsSchema = z.object({
  mailboxCleanupEnabled: z.boolean().describe("是否自动清理已过期的网关邮箱记录，默认关闭"),
  mailboxCleanupImmediate: z.boolean().describe("开启后过期即清理，不等待批量清理间隔"),
  mailboxCleanupIntervalMs: z.number().int().min(MIN_MAILBOX_CLEANUP_INTERVAL_MS).max(MAX_MAILBOX_CLEANUP_INTERVAL_MS).describe("批量清理间隔（毫秒），默认一小时"),
  healthCheckEnabled: z.boolean(),
  healthCheckIntervalMs: z.number().int().min(60_000).max(86_400_000),
  mailboxesPerKeyPerHour: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  maxConcurrentRequestsPerKey: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).openapi("GlobalSettings");

const UpdateSettingsBody = GlobalSettingsSchema.partial().extend({
  currentPassword: z.string().min(1).max(1024).optional(),
  newPassword: z.string().min(8).max(128).refine((p) => p.trim().length > 0, "密码不能全为空格").optional(),
}).strict().refine((body) => Object.keys(body).some((k) => k !== "currentPassword"), "请提供要修改的设置");

const errors = {
  400: { content: { "application/json": { schema: ErrorEnvelope } }, description: "参数不合法" },
  401: { content: { "application/json": { schema: ErrorEnvelope } }, description: "未登录" },
  403: { content: { "application/json": { schema: ErrorEnvelope } }, description: "当前密码不正确" },
};

/** 注册在 requireAdmin 之后；普通设置更新不要求重新输入密码。 */
export function registerSettingsRoutes(app: OpenAPIHono<Env>, deps: AdminDeps): void {
  app.openapi(createRoute({
    method: "get", path: "/admin/settings", tags: ["admin"], summary: "读取全局设置（不返回密码或摘要）",
    responses: {
      200: { content: { "application/json": { schema: z.object({ settings: GlobalSettingsSchema }) } }, description: "OK" },
      ...errors,
    },
  }), (c) => c.json({ settings: publicSettings(c.get("settings")) }, 200));

  app.openapi(createRoute({
    method: "patch", path: "/admin/settings", tags: ["admin"], summary: "保存全局设置；修改密码需验证当前密码，旧会话立即失效",
    request: { body: { content: { "application/json": { schema: UpdateSettingsBody } }, required: true } },
    responses: {
      200: { content: { "application/json": { schema: z.object({ settings: GlobalSettingsSchema, reauthenticationRequired: z.boolean() }) } }, description: "已保存" },
      ...errors,
    },
  }), async (c) => {
    const { currentPassword, newPassword, ...values } = c.req.valid("json");
    const credentialsChanged = newPassword !== undefined;
    const patch: SettingsPatch = { ...values };
    if (credentialsChanged) {
      if (!currentPassword || !await checkAdminPassword(currentPassword, currentAdminConfig(c, deps.admin))) {
        throw new AppError("FORBIDDEN", "当前密码不正确，无法修改登录密码");
      }
      // 每次改密刷新随机盐；以后改回原密码也不会恢复历史会话。
      patch.adminPasswordHash = await hashAdminPassword(newPassword);
    }
    await deps.stores.settings.update(patch);
    const saved = await readSettings(deps.stores.settings, deps.config);
    if (credentialsChanged) clearAdminSession(c);
    return c.json({ settings: publicSettings(saved), reauthenticationRequired: credentialsChanged }, 200);
  });
}
