import type { FastifyInstance } from 'fastify';
import {
  clearResolvedConstraints,
  deleteConstraint,
  listConstraints,
  setConstraintStatus,
} from '../repos/constraints.repo.js';
import { getProject } from '../repos/projects.repo.js';

export async function constraintRoutes(app: FastifyInstance): Promise<void> {
  /** 某个作品的写作约束（默认只看未解决的） */
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/projects/:id/constraints',
    async (req, reply) => {
      if (!getProject(req.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
      }
      const status =
        req.query.status === 'resolved' || req.query.status === 'all'
          ? (req.query.status as 'resolved' | 'all')
          : 'open';
      return listConstraints(req.params.id, status, 100);
    },
  );

  /** 标记已解决 / 重新打开 */
  app.patch<{ Params: { id: string }; Body: { status?: unknown } }>(
    '/api/constraints/:id',
    async (req, reply) => {
      const status = (req.body as { status?: unknown } | undefined)?.status;
      if (status !== 'open' && status !== 'resolved') {
        return reply
          .code(400)
          .send({ error: 'invalid_input', message: 'status 只能是 open 或 resolved' });
      }
      const ok = setConstraintStatus(req.params.id, status);
      if (!ok) return reply.code(404).send({ error: 'not_found', message: '约束不存在' });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/constraints/:id', async (req, reply) => {
    const ok = deleteConstraint(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '约束不存在' });
    return { ok: true };
  });

  /** 清掉所有已解决的记录 */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/constraints/clear-resolved',
    async (req, reply) => {
      if (!getProject(req.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
      }
      return { removed: clearResolvedConstraints(req.params.id) };
    },
  );
}
