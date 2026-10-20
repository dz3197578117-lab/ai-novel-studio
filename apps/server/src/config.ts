import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** apps/server 根目录 */
export const SERVER_ROOT = path.resolve(here, '..');

/** 运行期数据目录（数据库、图片、导出）。可用 NOVELFORGE_DATA_DIR 覆盖 */
export const DATA_DIR = process.env.NOVELFORGE_DATA_DIR
  ? path.resolve(process.env.NOVELFORGE_DATA_DIR)
  : path.join(SERVER_ROOT, 'data');

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
