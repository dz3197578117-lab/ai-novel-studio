import type { FastifyInstance } from 'fastify';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  listProjectsOverview,
  updateProject,
} from '../repos/projects.repo.js';
import { listChapters, getChapter, listVolumes } from '../repos/chapters.repo.js';
import { listEntities } from '../repos/entities.repo.js';
import { archiveDeleted } from '../repos/backup.js';
import { projectInput } from './schemas.js';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', async () => listProjects());

  /** 作品库：带统计信息，供「小说管理」使用。必须放在 /:id 之前 */
  app.get('/api/projects/overview', async () => listProjectsOverview());

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const p = getProject(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    return p;
  });

  app.post('/api/projects', async (req, reply) => {
    const parsed = projectInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    return reply.code(201).send(createProject(parsed.data));
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const parsed = projectInput.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const p = updateProject(req.params.id, parsed.data);
    if (!p) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    return p;
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });

    // 删除前完整留档，误删还能从 data/backups 找回
    const chapters = listChapters(project.id)
      .map((c) => getChapter(c.id))
      .filter(Boolean);
    archiveDeleted('project', {
      deletedAt: new Date().toISOString(),
      project,
      volumes: listVolumes(project.id),
      chapters,
      entities: listEntities(project.id),
    });

    const ok = deleteProject(project.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    return { ok: true };
  });
}
