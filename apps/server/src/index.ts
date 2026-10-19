import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOST, IMAGES_DIR, IS_DEV, PORT, PORT_RETRY, DATA_DIR } from './config.js';
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

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? (IS_DEV ? 'warn' : 'info'),
    },
    bodyLimit: 20 * 1024 * 1024,
  });

  await app.register(cors, { origin: IS_DEV ? true : false });

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
    reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return app;
}

async function main() {
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
