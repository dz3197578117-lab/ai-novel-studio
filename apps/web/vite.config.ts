import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析后端地址：
 * 1. 环境变量 NOVELFORGE_API 优先
 * 2. 读取 server 写入的 data/server-port（后端可能因端口占用顺延）
 * 3. 回退到 8787
 */
function resolveApiTarget(): string {
  if (process.env.NOVELFORGE_API) return process.env.NOVELFORGE_API;
  try {
    const portFile = path.resolve(here, '../server/data/server-port');
    const port = fs.readFileSync(portFile, 'utf8').trim();
    if (/^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
  } catch {
    /* 后端还没启动过，用默认值 */
  }
  return 'http://127.0.0.1:8787';
}

const API_TARGET = resolveApiTarget();

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    watch: {
      /**
       * 编辑器（VS Code、以及自动化工具）保存文件时会先写 `.xxx.tmpdir/xxx.tmp`
       * 再重命名。Vite 的文件监听器一旦 watch 到这类临时文件就会因 EBUSY
       * 直接崩溃，整个前端服务挂掉。这里显式忽略它们。
       */
      ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/.DS_Store', '**/*.swp'],
    },
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/files': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
