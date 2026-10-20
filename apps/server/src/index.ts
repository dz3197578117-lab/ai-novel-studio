import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOST, IMAGES_DIR, IS_DEV, PORT, PORT_RETRY, DATA_DIR, ACCESS_TOKEN, IS_LOCAL_BIND } from './config.js';
import { getDb } from './db.js';
import { startAutoBackup } from './repos/backup.js';
import { projectRoutes } from './routes/projects.routes.js';
import { entityRoutes } from './routes/entities.routes.js';
import { chapterRoutes } from './routes/chapters.routes.js';
import { writeRoutes } from './routes/write.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { exportRoutes } from './routes/export.routes.js';
import { imageRoutes } from './routes/images.routes.js';
import { draftRoutes } from './routes/draft.routes.js';
import { consistencyRoutes } from './routes/consistency.routes.js';
import { layerRoutes } from './routes/layers.routes.js';
import { knowledgeRoutes } from './routes/knowledge.routes.js';
import { dshRoutes } from './routes/dsh.routes.js';
import { planRoutes } from './routes/plan.routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? (IS_DEV ? 'warn' : 'info'),
    },
    bodyLimit: 20 * 1024 * 1024,
  });

  await app.register(cors, { origin: IS_DEV ? true : false });

  /**
   * 监听非本机地址时强制校验访问令牌。
   * 本机（默认）不校验，保持「打开就能用」；一旦用 HOST=0.0.0.0 共享到局域网，
   * 没有这道门，同网段任何人都能读写全部作品、用你的 Key 消耗额度。
   * 图片静态资源不校验：URL 里是随机 UUID，且 <img> 无法携带请求头。
   */
  app.addHook('onRequest', async (req, reply) => {
    if (IS_LOCAL_BIND || !ACCESS_TOKEN) return;
    if (req.url.startsWith('/files/')) return;

    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const queryToken = (req.query as { token?: string } | undefined)?.token;
    if ((bearer ?? queryToken) !== ACCESS_TOKEN) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: '需要访问令牌：启动时设置 ACCESS_TOKEN，并在请求头带上 Authorization: Bearer <token>',
      });
    }
  });

  // 静态资源：生成的图片
  await app.register(fastifyStatic, {
    root: IMAGES_DIR,
    prefix: '/files/images/',
    decorateReply: false,
  });

  await app.register(projectRoutes);
  await app.register(entityRoutes);
  await app.register(chapterRoutes);
  await app.register(writeRoutes);
  await app.register(settingsRoutes);
  await app.register(exportRoutes);
  await app.register(imageRoutes);
  await app.register(draftRoutes);
  await app.register(consistencyRoutes);
  await app.register(layerRoutes);
  await app.register(knowledgeRoutes);
  await app.register(dshRoutes);
  await app.register(planRoutes);

  app.get('/api/health', async () => ({ ok: true, dataDir: DATA_DIR }));

  // 生产模式下托管前端构建产物（单进程部署）
  const webDist = path.resolve(here, '../../web/dist');
  if (!IS_DEV && fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      decorateReply: true,
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.code(404).send({ error: 'not_found', message: '接口不存在' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const name = (err as { name?: string }).name;
    // 上游模型错误（AiError）的 message 是给用户看的（限流、Key 无效等），要保留；
    // 其余 5xx 是内部故障，生产环境不能把 SQL / 路径细节直接吐给客户端。
    const safeToExpose = status < 500 || name === 'AiError' || IS_DEV;
    reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: safeToExpose
        ? err instanceof Error
          ? err.message
          : String(err)
        : '服务器内部错误，详情见服务端日志',
    });
  });

  return app;
}

async function main() {
  if (!IS_LOCAL_BIND && !ACCESS_TOKEN) {
    console.error(
      `\n  拒绝启动：HOST=${HOST} 会把作品暴露到局域网，但没有设置 ACCESS_TOKEN。\n` +
        `  请改用：ACCESS_TOKEN=你的口令 HOST=${HOST} pnpm start\n` +
        `  或恢复本机访问：HOST=127.0.0.1 pnpm start\n`,
    );
    process.exit(1);
  }

  getDb();
  // 数据库定期自动备份（有作品被误删后无从恢复的教训）
  startAutoBackup();
  const app = await buildServer();

  // 端口被占用时自动顺延，避免用户机器上别的程序占着默认端口就启动失败
  let port = PORT;
  for (let attempt = 0; attempt < PORT_RETRY; attempt++) {
    try {
      await app.listen({ port, host: HOST });
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' && attempt < PORT_RETRY - 1) {
        console.warn(`端口 ${port} 被占用，尝试 ${port + 1}…`);
        port += 1;
        continue;
      }
      throw e;
    }
  }

  // 把实际端口写给 Vite 开发服务器读取
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'server-port'), String(port), 'utf8');
  } catch {
    /* 非致命 */
  }

  console.log(`\n  NovelForge 服务已启动 → http://${HOST}:${port}\n  数据目录: ${DATA_DIR}\n`);
}

const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntry) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
