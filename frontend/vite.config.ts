import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/admin': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 清空由 build 脚本前置的 rimraf 完成：Vite 自带的 emptyOutDir 在 Git Bash 下
    // 删除目录会静默失败并中断构建，故此处保持 false。
    emptyOutDir: false,
    minify: true,
  },
});
