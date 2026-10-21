import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * 是否运行在「单文件」环境（Node SEA / pkg）。
 *
 * 打包后没有源码目录，`import.meta.url` 也会失效（CJS bundle 里是空的），
 * 所以路径一律以可执行文件为基准。
 */
export const IS_PACKAGED = (() => {
  try {
    const proc = process as unknown as {
      getBuiltinModule?: (id: string) => { isSea?: () => boolean } | undefined;
      pkg?: unknown;
    };
    if (proc.getBuiltinModule?.('node:sea')?.isSea?.()) return true;
    if (proc.pkg) return true;
  } catch {
    /* 老版本 Node 没有 node:sea */
  }
  return false;
})();

/**
 * 源码根目录（apps/server）。
 * 打包后是 exe 所在目录——`web/` 与可选的 `package.json` 都在这里。
 */
export const SERVER_ROOT = (() => {
  if (IS_PACKAGED) return path.dirname(process.execPath);
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return path.dirname(process.execPath);
  }
})();

/** 用户数据目录：Windows 用 %APPDATA%，macOS 用 Application Support，其他用 XDG */
function appDataDir(): string {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return path.join(os.homedir(), '.local', 'share');
}

/**
 * 运行期数据目录（数据库、图片、导出）。
 * - 开发：apps/server/data
 * - 打包：%APPDATA%/NovelForge
 * - NOVELFORGE_PORTABLE=1：exe 同级的 data/（便携模式，需目录可写）
 */
export const DATA_DIR = process.env.NOVELFORGE_DATA_DIR
  ? path.resolve(process.env.NOVELFORGE_DATA_DIR)
  : IS_PACKAGED
    ? process.env.NOVELFORGE_PORTABLE === '1'
      ? path.join(SERVER_ROOT, 'data')
      : path.join(appDataDir(), 'NovelForge')
    : path.join(SERVER_ROOT, 'data');

/**
 * 前端构建产物目录。
 * 开发：apps/web/dist；打包：exe 同级 web/。
 */
export const WEB_DIR = process.env.NOVELFORGE_WEB_DIR
  ? path.resolve(process.env.NOVELFORGE_WEB_DIR)
  : IS_PACKAGED
    ? path.join(SERVER_ROOT, 'web')
    : path.resolve(SERVER_ROOT, '../web/dist');

export const DB_PATH = path.join(DATA_DIR, 'novelforge.db');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports');

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '127.0.0.1';

/** 是否只监听本机。监听 0.0.0.0 意味着同网段任何人都能读写你的作品 */
export const IS_LOCAL_BIND = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

/**
 * 非本机监听时必须设置的访问令牌。
 * 本地单人工具没有账号体系，暴露到局域网后至少要靠一个共享令牌挡住陌生人。
 */
export const ACCESS_TOKEN = process.env.ACCESS_TOKEN ?? '';

/** 端口被占用时自动顺延，最多尝试 10 个 */
export const PORT_RETRY = 10;

/** 仅开发模式允许任意来源（Vite 端口会变） */
export const IS_DEV = process.env.NODE_ENV !== 'production';
