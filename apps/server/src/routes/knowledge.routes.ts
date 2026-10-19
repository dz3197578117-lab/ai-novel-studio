import type { FastifyInstance } from 'fastify';
import { createDoc, deleteDoc, getDoc, listDocs, searchKnowledge } from '../repos/layers.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { knowledgeInput } from './schemas.js';

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/projects/:id/knowledge', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    return listDocs(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/knowledge', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    const parsed = knowledgeInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    return reply.code(201).send(createDoc(req.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>('/api/knowledge/:id', async (req, reply) => {
    const doc = getDoc(req.params.id);
    if (!doc) return reply.code(404).send({ error: 'not_found', message: '资料不存在' });
    return doc;
  });

  app.delete<{ Params: { id: string } }>('/api/knowledge/:id', async (req, reply) => {
    const ok = deleteDoc(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '资料不存在' });
    return { ok: true };
  });

  /** 关键词检索，用于确认「AI 写作时会引用哪些资料」 */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/api/projects/:id/knowledge/search',
    async (req, reply) => {
      if (!getProject(req.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
      }
      const q = req.query.q ?? '';
      return { hits: searchKnowledge(req.params.id, q, 8) };
    },
  );
}
