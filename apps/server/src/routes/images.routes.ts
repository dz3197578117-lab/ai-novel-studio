import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GeneratedImage } from '@novelforge/shared';
import { getDb, newId, nowIso } from '../db.js';
import { IMAGES_DIR } from '../config.js';
import { getImageConfig } from '../repos/settings.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { imageRequest } from './schemas.js';

interface ImageRow {
  id: string;
  project_id: string;
  chapter_id: string | null;
  prompt: string;
  url: string;
  kind: 'cover' | 'illustration';
  created_at: string;
}

const toImage = (r: ImageRow): GeneratedImage => ({
  id: r.id,
  projectId: r.project_id,
  chapterId: r.chapter_id,
  prompt: r.prompt,
  url: r.url,
  kind: r.kind,
  createdAt: r.created_at,
  updatedAt: r.created_at,
});

export async function imageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/projects/:id/images', async (req) => {
    const rows = getDb()
      .prepare('SELECT * FROM images WHERE project_id = ? ORDER BY created_at DESC')
      .all(req.params.id) as unknown as ImageRow[];
    return rows.map(toImage);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/images', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    const parsed = imageRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const cfg = getImageConfig();
    if (!cfg.apiKey || !cfg.baseUrl) {
      return reply.code(412).send({
        error: 'not_configured',
        message: '尚未配置图像模型，请先在「设置」中填写。',
      });
    }

    try {
      const url = `${cfg.baseUrl.replace(/\/+$/, '')}/images/generations`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          prompt: parsed.data.prompt,
          n: 1,
          size: parsed.data.size ?? '1024x1024',
          response_format: 'b64_json',
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return reply
          .code(502)
          .send({ error: 'upstream_error', message: `图像生成失败 (${res.status}): ${detail.slice(0, 300)}` });
      }
      const json = (await res.json()) as {
        data?: { b64_json?: string; url?: string }[];
      };
      const item = json.data?.[0];
      const id = newId();
      const fileName = `${id}.png`;
      const filePath = path.join(IMAGES_DIR, fileName);

      if (item?.b64_json) {
        await fs.writeFile(filePath, Buffer.from(item.b64_json, 'base64'));
      } else if (item?.url) {
        const imgRes = await fetch(item.url);
        if (!imgRes.ok) throw new Error('下载生成的图片失败');
        await fs.writeFile(filePath, Buffer.from(await imgRes.arrayBuffer()));
      } else {
        return reply.code(502).send({ error: 'upstream_error', message: '图像接口未返回图片数据' });
      }

      const rel = `/files/images/${fileName}`;
      getDb()
        .prepare(
          'INSERT INTO images (id, project_id, chapter_id, prompt, url, kind, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          id,
          req.params.id,
          parsed.data.chapterId ?? null,
          parsed.data.prompt,
          rel,
          parsed.data.kind ?? 'illustration',
          nowIso(),
        );

      return reply.code(201).send(toImage(
        getDb().prepare('SELECT * FROM images WHERE id = ?').get(id) as unknown as ImageRow,
      ));
    } catch (e) {
      return reply.code(502).send({ error: 'upstream_error', message: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/images/:id', async (req, reply) => {
    const row = getDb().prepare('SELECT * FROM images WHERE id = ?').get(req.params.id) as
      | ImageRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found', message: '图片不存在' });
    const fileName = path.basename(row.url);
    await fs.unlink(path.join(IMAGES_DIR, fileName)).catch(() => {});
    getDb().prepare('DELETE FROM images WHERE id = ?').run(req.params.id);
    return { ok: true };
  });
}
