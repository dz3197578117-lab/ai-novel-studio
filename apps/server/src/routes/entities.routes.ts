import type { FastifyInstance } from 'fastify';
import type { EntityType } from '@novelforge/shared';
import {
  createEntity,
  deleteEntity,
  getEntity,
  listEntities,
  updateEntity,
} from '../repos/entities.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { entityInput } from './schemas.js';

const TYPES: EntityType[] = ['world', 'character', 'faction', 'term', 'item', 'location'];

export async function entityRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { type?: string } }>(
    '/api/projects/:id/entities',
    async (req, reply) => {
      if (!getProject(req.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
      }
      const t = req.query.type as EntityType | undefined;
      return listEntities(req.params.id, t && TYPES.includes(t) ? t : undefined);
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/entities', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    const parsed = entityInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    return reply.code(201).send(createEntity(req.params.id, parsed.data));
  });

  app.patch<{ Params: { id: string } }>('/api/entities/:id', async (req, reply) => {
    const parsed = entityInput.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const e = updateEntity(req.params.id, parsed.data);
    if (!e) return reply.code(404).send({ error: 'not_found', message: '设定不存在' });
    return e;
  });

  app.get<{ Params: { id: string } }>('/api/entities/:id', async (req, reply) => {
    const e = getEntity(req.params.id);
    if (!e) return reply.code(404).send({ error: 'not_found', message: '设定不存在' });
    return e;
  });

  app.delete<{ Params: { id: string } }>('/api/entities/:id', async (req, reply) => {
    const ok = deleteEntity(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '设定不存在' });
    return { ok: true };
  });
}
