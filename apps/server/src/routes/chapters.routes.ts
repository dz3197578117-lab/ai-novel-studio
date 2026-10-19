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
import { archiveDeleted, archiveDeletedBatch } from '../repos/backup.js';
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
    const chapter = getChapter(req.params.id);
    if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
    // 正文可能很长，删前留档
    archiveDeleted('chapter', { deletedAt: new Date().toISOString(), chapter });
    const ok = deleteChapter(chapter.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
    return { ok: true };
  });

  /** 批量删除章节（千章规模下逐条点太痛苦） */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/chapters/batch-delete',
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
      const body = req.body as { ids?: unknown } | undefined;
      const ids = Array.isArray(body?.ids)
        ? body!.ids.filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) {
        return reply.code(400).send({ error: 'empty', message: '没有选中任何章节' });
      }

      const doomed = [];
      for (const id of ids.slice(0, 1000)) {
        const chapter = getChapter(id);
        // 只删本项目下的章节，避免误删
        if (!chapter || chapter.projectId !== project.id) continue;
        doomed.push(chapter);
      }
      // 整批写一个留档文件，删再多也不会把前面的记录挤掉
      if (doomed.length) {
        archiveDeletedBatch('chapter', doomed, { projectId: project.id });
      }

      let deleted = 0;
      for (const chapter of doomed) {
        if (deleteChapter(chapter.id)) deleted++;
      }
      touchProject(project.id);
      return { ok: true, deleted };
    },
  );

  /** 批量把章节移到某卷（volumeId 传 null 表示移出卷） */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/chapters/batch-move',
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
      const body = req.body as { ids?: unknown; volumeId?: unknown } | undefined;
      const ids = Array.isArray(body?.ids)
        ? body!.ids.filter((x): x is string => typeof x === 'string')
        : [];
      const volumeId =
        typeof body?.volumeId === 'string' && body.volumeId ? body.volumeId : null;
      if (ids.length === 0) {
        return reply.code(400).send({ error: 'empty', message: '没有选中任何章节' });
      }
      // 目标卷必须属于本项目
      if (volumeId) {
        const exists = listVolumes(project.id).some((v) => v.id === volumeId);
        if (!exists) {
          return reply.code(404).send({ error: 'not_found', message: '目标卷不存在' });
        }
      }

      let moved = 0;
      for (const id of ids.slice(0, 1000)) {
        const chapter = getChapter(id);
        if (!chapter || chapter.projectId !== project.id) continue;
        updateChapter(id, { volumeId });
        moved++;
      }
      touchProject(project.id);
      return { ok: true, moved };
    },
  );

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
