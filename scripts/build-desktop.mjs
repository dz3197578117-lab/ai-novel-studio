/**
 * 构建桌面版（Electron）。
 *
 *   node scripts/build-desktop.mjs              # Windows x64 绿色版目录 + zip
 *   node scripts/build-desktop.mjs --linux      # Linux 目录（本机验证用）
 *   node scripts/build-desktop.mjs --server-only # 只打 server.cjs，供 electron 直接跑
 *
 * 产物：
 *   apps/desktop/dist/win-unpacked/   可直接运行（NovelForge.exe）
 *   NovelForge-desktop-win-x64.zip    对外发布用
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(root, 'apps/desktop');
const serverOut = path.join(desktopDir, 'build/server.cjs');

const args = process.argv.slice(2);
const onlyServer = args.includes('--server-only');
const linux = args.includes('--linux');

function log(step) {
  console.log(`\n[desktop] ${step}`);
}

log('构建前端');
execSync('pnpm --filter @novelforge/web build', { cwd: root, stdio: 'inherit' });

log('打包服务端');
await build({
  entryPoints: [path.join(root, 'apps/server/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: serverOut,
  external: ['node:sqlite'],
  logLevel: 'warning',
  charset: 'utf8',
});

if (onlyServer) {
  console.log(`\n完成：${serverOut}`);
  process.exit(0);
}

log(linux ? '打包 Linux 目录' : '打包 Windows 目录');
const builder = path.join(root, 'node_modules/.bin/electron-builder');
execFileSync(builder, linux ? ['--linux', '--x64', '--dir'] : ['--win', '--x64', '--dir'], {
  cwd: desktopDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    // 国内镜像，避免 electron / nsis 资源下载被墙
    ELECTRON_MIRROR:
      process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??
      'https://npmmirror.com/mirrors/electron-builder-binaries/',
  },
});

if (linux) {
  console.log(`\n完成：${path.join(desktopDir, 'dist/linux-unpacked')}`);
  process.exit(0);
}

const unpacked = path.join(desktopDir, 'dist/win-unpacked');
if (!fs.existsSync(unpacked)) throw new Error(`没有找到打包目录：${unpacked}`);

log('压缩为 zip');
const zipPath = path.join(root, 'NovelForge-desktop-win-x64.zip');
fs.rmSync(zipPath, { force: true });
execSync(`zip -qr "${zipPath}" .`, { cwd: unpacked, stdio: 'inherit' });

const size = fs.statSync(zipPath).size;
console.log(`\n完成：${zipPath}`);
console.log(`大小：${(size / 1024 / 1024).toFixed(1)} MB`);
