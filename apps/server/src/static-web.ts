import type { FastifyInstance } from 'fastify';
import { WEB_ASSETS } from './web-assets.generated.js';

type EmbeddedAsset = { type: string; base64: string };

const ASSETS = WEB_ASSETS as Record<string, EmbeddedAsset>;

/** 构建时是否真的把前端打进来了（源码运行时为空表） */
export function hasEmbeddedWeb(): boolean {
  return Object.keys(ASSETS).length > 0;
}

function cacheControlFor(key: string): string {
  // index.html 不能缓存，否则更新 exe 后浏览器还开着旧入口
  if (key === 'index.html') return 'no-cache';
  // Vite 产物文件名带内容哈希，可以长期缓存
  if (key.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

/**
 * 从 exe 内嵌资源提供前端页面。
 *
 * 打包后没有 `web/` 目录，靠这里兜底；如果用户在 exe 同级放了 `web/`，
 * 主流程仍走磁盘（便于手动替换前端），这里只处理“没有目录”的情况。
 *
 * 只查内存表、不拼文件系统路径，天然没有目录穿越问题。
 */
export function registerEmbeddedWeb(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'not_found', message: '接口不存在' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ error: 'not_found', message: '页面不存在' });
    }

    let pathname = req.url.split('?')[0]!.split('#')[0]!;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      /* 非法转义按原始路径查，查不到就走首页 */
    }
    const key = pathname.replace(/^\/+/, '') || 'index.html';

    const asset = ASSETS[key];
    if (asset) {
      return reply
        .type(asset.type)
        .header('cache-control', cacheControlFor(key))
        .send(Buffer.from(asset.base64, 'base64'));
    }

    // 刷新根路径以外的地址时回落到首页；
    // 带扩展名的请求当作静态资源，缺失就 404 —— 回 HTML 会让浏览器报 MIME 错
    if (/\.[a-z0-9]+$/i.test(key)) {
      return reply.code(404).send({ error: 'not_found', message: '资源不存在' });
    }

    const index = ASSETS['index.html'];
    if (index) {
      return reply
        .type(index.type)
        .header('cache-control', 'no-cache')
        .send(Buffer.from(index.base64, 'base64'));
    }
    return reply.code(404).send({ error: 'not_found', message: '页面不存在' });
  });
}
