/**
 * 构建可双击运行的 NovelForge 单文件版（Node SEA）。
 *
 * 用法：
 *   node scripts/build-exe.mjs                 # Windows x64（默认）
 *   node scripts/build-exe.mjs --target linux-x64   # 本机验证用
 *
 * 产物：build-exe/NovelForge-win-x64.zip
 *   NovelForge.exe   ← 单文件服务端（内嵌打包后的 JS）
 *   web/             ← 前端静态文件
 *   package.json     ← 版本号（更新检查读取）
 *   README.txt
 *
 * 注意：Node SEA 不支持把静态文件打进 exe，所以 web/ 必须与 exe 放在一起。
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build-exe');
// 缓存放在产物目录之外：outDir 每次构建都会清空
const cacheDir = path.join(root, 'build-exe-cache');

const targetArg = process.argv.find((a) => a.startsWith('--target='))?.split('=')[1] ?? 'win-x64';
const target = targetArg === 'linux-x64' ? 'linux-x64' : 'win-x64';
const isWinTarget = target === 'win-x64';
const nodeVersion = process.env.NOVELFORGE_NODE_VERSION ?? process.versions.node;
const exeName = isWinTarget ? 'NovelForge.exe' : 'NovelForge';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(step) {
  console.log(`\n[build-exe] ${step}`);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

/** 产物里不需要 sourcemap：既占体积，也把源码结构带出去了 */
function stripMaps(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) stripMaps(full);
    else if (entry.name.endsWith('.map')) fs.rmSync(full, { force: true });
  }
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf.length;
}

async function main() {
  log(`目标 ${target} · Node v${nodeVersion}`);

  // 1. 前端构建
  log('构建前端');
  execSync('pnpm --filter @novelforge/web build', { cwd: root, stdio: 'inherit' });

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  // 2. 前端静态文件
  log('复制前端产物到 web/');
  copyDir(path.join(root, 'apps/web/dist'), path.join(outDir, 'web'));
  stripMaps(path.join(outDir, 'web'));

  // 3. 服务端打包成单文件 CJS
  log('打包服务端（esbuild）');
  await build({
    entryPoints: [path.join(root, 'apps/server/src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: path.join(outDir, 'server.cjs'),
    external: ['node:sqlite'],
    // 便携版固定生产模式：否则双击 exe 时 IS_DEV 为真，不托管前端
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });

  // 4. SEA blob
  log('生成 SEA blob');
  const seaConfig = {
    main: path.join(outDir, 'server.cjs'),
    output: path.join(outDir, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
  };
  fs.writeFileSync(path.join(outDir, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
  run(process.execPath, ['--experimental-sea-config', path.join(outDir, 'sea-config.json')]);

  // 5. 准备目标平台的 node 二进制
  let baseNode;
  if (isWinTarget) {
    const zip = path.join(cacheDir, `node-v${nodeVersion}-win-x64.zip`);
    // 官方 zip 自带一层 node-vX-win-x64/ 目录，解压到 cacheDir 即可
    const unpacked = path.join(cacheDir, `node-v${nodeVersion}-win-x64`);
    if (!fs.existsSync(path.join(unpacked, 'node.exe'))) {
      fs.mkdirSync(cacheDir, { recursive: true });
      if (!fs.existsSync(zip)) {
        log(`下载 Node v${nodeVersion} Windows 版`);
        const size = await download(
          `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`,
          zip,
        );
        console.log(`  已下载 ${(size / 1024 / 1024).toFixed(1)} MB`);
      }
      log('解压 Node');
      if (process.platform === 'win32') {
        run('tar', ['-xf', zip, '-C', cacheDir]);
      } else {
        run('unzip', ['-q', '-o', zip, '-d', cacheDir]);
      }
    }
    baseNode = path.join(unpacked, 'node.exe');
  } else {
    baseNode = process.execPath;
  }

  const exePath = path.join(outDir, exeName);
  fs.copyFileSync(baseNode, exePath);
  if (!isWinTarget) fs.chmodSync(exePath, 0o755);

  // 6. Windows 的 node.exe 带 Authenticode 签名，注入后签名失效；能剥就剥掉
  if (isWinTarget) {
    try {
      const unsigned = `${exePath}.unsigned`;
      execFileSync('osslsigncode', ['remove-signature', '-in', exePath, '-out', unsigned], {
        stdio: 'ignore',
      });
      fs.rmSync(exePath);
      fs.renameSync(unsigned, exePath);
      log('已移除 node.exe 的旧签名');
    } catch {
      log('未安装 osslsigncode，保留原签名（注入后签名会失效，不影响运行）');
    }
  }

  // 7. 注入
  log('注入 SEA blob');
  await inject(exePath, 'NODE_SEA_BLOB', fs.readFileSync(path.join(outDir, 'sea-prep.blob')), {
    sentinelFuse: SEA_FUSE,
  });

  // 8. 版本文件：更新检查需要读 package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.writeFileSync(
    path.join(outDir, 'package.json'),
    JSON.stringify({ name: 'novelforge-portable', version: pkg.version, private: true }, null, 2),
  );

  // 9. 说明文件
  fs.writeFileSync(
    path.join(outDir, 'README.txt'),
    [
      'NovelForge 便携版',
      '',
      '1. 双击 NovelForge.exe 启动，浏览器会自动打开 http://127.0.0.1:8787',
      '2. web 文件夹必须与 exe 放在同一目录，否则页面打不开',
      '3. 数据默认存在 %APPDATA%\\NovelForge（数据库、图片、备份）',
      '   想放在 exe 旁边：先建一个 data 文件夹，再设环境变量 NOVELFORGE_PORTABLE=1',
      '4. 端口被占用会自动顺延到 8788、8789…，以控制台显示的地址为准',
      '5. 关闭控制台窗口即停止服务',
      '',
      `版本 ${pkg.version}`,
    ].join('\r\n'),
    'utf8',
  );

  // 10. 压缩
  log('打包 zip');
  const zipName = `NovelForge-${target}.zip`;
  const zipPath = path.join(root, zipName);
  fs.rmSync(zipPath, { force: true });
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${exePath}','${path.join(outDir, 'web')}','${path.join(outDir, 'package.json')}','${path.join(outDir, 'README.txt')}' -DestinationPath '${zipPath}' -Force"`,
      { cwd: root, stdio: 'inherit' },
    );
  } else {
    execSync(
      `zip -qr "${zipPath}" "${exeName}" web package.json README.txt -x "*.cache*"`,
      { cwd: outDir, stdio: 'inherit' },
    );
  }

  const size = fs.statSync(zipPath).size;
  console.log(`\n完成：${zipPath}`);
  console.log(`大小：${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`可执行文件：${exePath}`);
}

main().catch((e) => {
  console.error('\n构建失败：', e);
  process.exit(1);
});
