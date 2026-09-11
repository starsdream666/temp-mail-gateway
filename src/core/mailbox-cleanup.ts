import type { MailboxStore } from "../ports/stores";

/** Node/Docker 后台检查精度；Workers 由 Cron 和邮箱概览请求触发，不使用常驻定时器。 */
export const MAILBOX_CLEANUP_SWEEP_INTERVAL_MS = 1_000;

/** 只操作网关数据库，不访问上游；跨实例的调度与失败回滚由存储层保证。 */
export async function runMailboxCleanup(mailboxes: MailboxStore, now = new Date()): Promise<number> {
  const deleted = await mailboxes.deleteExpiredAutomatically(now);
  if (deleted > 0) console.log("[mailbox-cleanup] 已清理过期邮箱记录:", deleted);
  return deleted;
}
