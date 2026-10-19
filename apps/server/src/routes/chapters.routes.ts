import type { FastifyInstance } from 'fastify';
import type { ID } from '@novelforge/shared';
import {
  createChapter,
  createVolume,
  deleteChapter,
  deleteVolume,
  getChapter,
  listChapters,
  listVolumes,
  reorderChapters,
  updateChapter,
  updateVolume,
} from '../repos/chapters.repo.js';
import { getProject, touchProject } from '../repos/projects.repo.js';
import { chapterInput, volumeInput } from './schemas.js';

export async function chapterRoutes(app: FastifyInstance): Promise<void> {
  // ── 卷 ──
  app.get<{ Params: { id: string } }>('/api/projects/:id/volumes', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    return listVolumes(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/volumes', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    const parsed = volumeInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    touchProject(req.params.id);
    return reply.code(201).send(createVolume(req.params.id, parsed.data.title, parsed.data.summary));
  });

  app.patch<{ Params: { id: string } }>('/api/volumes/:id', async (req, reply) => {
    const parsed = volumeInput
      .partial()
      .extend({ order: volumeInput.shape.title.optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const v = updateVolume(req.params.id, parsed.data as never);
    if (!v) return reply.code(404).send({ error: 'not_found', message: '卷不存在' });
    return v;
  });

  app.delete<{ Params: { id: string } }>('/api/volumes/:id', async (req, reply) => {
    const ok = deleteVolume(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '卷不存在' });
    return { ok: true };
  });

  // ── 章节 ──
  app.get<{ Params: { id: string } }>('/api/projects/:id/chapters', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    return listChapters(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/chapters', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    const parsed = chapterInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    touchProject(req.params.id);
    return reply.code(201).send(createChapter(req.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>('/api/chapters/:id', async (req, reply) => {
    const c = getChapter(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
    return c;
  });

  app.patch<{ Params: { id: string } }>('/api/chapters/:id', async (req, reply) => {
    const parsed = chapterInput.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const c = updateChapter(req.params.id, parsed.data);
    if (!c) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
    touchProject(c.projectId);
    return c;
  });

  app.delete<{ Params: { id: string } }>('/api/chapters/:id', async (req, reply) => {
    const ok = deleteChapter(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { order?: ID[] } }>(
    '/api/projects/:id/chapters/reorder',
    async (req, reply) => {
      const order = (req.body as { order?: ID[] } | undefined)?.order;
      if (!Array.isArray(order)) {
        return reply.code(400).send({ error: 'invalid_input', message: 'order 必须是数组' });
      }
      reorderChapters(req.params.id, order);
      return { ok: true };
    },
  );
}
