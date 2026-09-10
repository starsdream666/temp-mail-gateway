import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * 清空 dist。相比原先内联的 `node -e "...rmSync(dist,{force:true})"`，这里解决的是
 * Windows 上的真实问题：文件句柄延迟释放时 rmSync 会抛 EPERM，而 `force: true`
 * 会把它一并吞掉 —— 于是清理"成功"，dist 里却残留着上一次构建的哈希文件，
 * index.html 指向新 bundle、旧 bundle 也还在，排查时极易被误导。
 *
 * 因此：显式重试几轮等句柄释放，最终仍失败就以非零退出码中断构建链，
 * 不让残留文件蒙混过关。
 */
const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    rmSync(dist, { recursive: true, force: true });
    console.log("cleaned dist");
    process.exit(0);
  } catch (err) {
    if (attempt === 3) {
      console.error(`无法清空 ${dist}（可能有进程占用文件句柄）：`, err);
      process.exit(1);
    }
    // 短暂等待句柄释放后重试
    const until = Date.now() + 300;
    while (Date.now() < until) {
      /* busy wait：清理脚本不值得引入异步依赖 */
    }
  }
}
