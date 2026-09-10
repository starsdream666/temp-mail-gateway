import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";

/**
 * Node 侧迁移执行器：按文件名顺序执行 ./migrations/*.sql，
 * 已执行记录存在 __migrations 表（与 wrangler d1 migrations 的 d1_migrations 表互不影响）。
 */
export function runMigrations(db: BetterSqlite3.Database, migrationsDir: string): void {
  db.exec("CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set<string>(
    (db.prepare("SELECT name FROM __migrations").all() as { name: string }[]).map((r) => r.name),
  );

  if (!existsSync(migrationsDir)) return;
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    db.exec(sql);
    db.prepare("INSERT INTO __migrations (name, applied_at) VALUES (?, ?)").run(file, Date.now());
  }
}
