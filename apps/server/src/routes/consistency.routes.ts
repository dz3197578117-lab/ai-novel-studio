import type { FastifyInstance } from 'fastify';
import type { ConsistencyReport } from '@novelforge/shared';
import {
  createForeshadow,
  createTimelineEvent,
  deleteForeshadow,
  deleteTimelineEvent,
  listForeshadows,
  listTimeline,
  updateForeshadow,
  updateTimelineEvent,
} from '../repos/consistency.repo.js';
import { listChapterDigests, getLastChapterContent } from '../repos/chapters.repo.js';
import { listEntities } from '../repos/entities.repo.js';
import { listDocs } from '../repos/layers.repo.js';
import { addConstraints } from '../repos/constraints.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { AiError, completeAccumulated, loadTextConfig } from '../ai/client.js';
import { buildConsistencyPrompt, parseConsistencyReport } from '../ai/consistency.js';
import { foreshadowInput, timelineInput } from './schemas.js';

const CHECK_TIMEOUT_MS = 180_000;

export async function consistencyRoutes(app: FastifyInstance): Promise<void> {
  // ── 伏笔台账 ──
  app.get<{ Params: { id: string } }>('/api/projects/:id/foreshadows', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    return listForeshadows(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/foreshadows', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    const parsed = foreshadowInput.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    return reply.code(201).send(createForeshadow(req.params.id, parsed.data));
  });

  app.patch<{ Params: { id: string } }>('/api/foreshadows/:id', async (req, reply) => {
    const parsed = foreshadowInput.partial().safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    const updated = updateForeshadow(req.params.id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'not_found', message: '伏笔不存在' });
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/foreshadows/:id', async (req, reply) => {
    const ok = deleteForeshadow(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '伏笔不存在' });
    return { ok: true };
  });

  // ── 时间线 ──
  app.get<{ Params: { id: string } }>('/api/projects/:id/timeline', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    return listTimeline(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/timeline', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    const parsed = timelineInput.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    return reply.code(201).send(createTimelineEvent(req.params.id, parsed.data));
  });

  app.patch<{ Params: { id: string } }>('/api/timeline/:id', async (req, reply) => {
    const parsed = timelineInput.partial().safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    const updated = updateTimelineEvent(req.params.id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'not_found', message: '事件不存在' });
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/timeline/:id', async (req, reply) => {
    const ok = deleteTimelineEvent(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '事件不存在' });
    return { ok: true };
  });

  // ── 一致性检查 ──
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/consistency-check',
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });

      let config;
      try {
        config = loadTextConfig();
      } catch (e) {
        if (e instanceof AiError) {
          return reply.code(412).send({ error: 'not_configured', message: e.message });
        }
        throw e;
      }

      // 组装检查材料：设定 + 伏笔 + 时间线 + 章节梗概。
      // 只取摘要列，正文单独取最后一章——检查器判断「当下写法」只需要这一章。
      const chapters = listChapterDigests(project.id);
      if (chapters.length > 0) {
        chapters[chapters.length - 1]!.content = getLastChapterContent(project.id);
      }

      if (chapters.length === 0 && listEntities(project.id).length === 0) {
        return reply.code(400).send({
          error: 'empty',
          message: '还没有设定和章节，没什么可检查的。',
        });
      }

      const prompt = buildConsistencyPrompt({
        project,
        entities: listEntities(project.id),
        chapters,
        foreshadows: listForeshadows(project.id),
        timeline: listTimeline(project.id),
        knowledge: listDocs(project.id).map((d) => ({
          title: d.title,
          source: d.source,
          excerpt: d.content.slice(0, 200),
        })),
      });

      try {
        // 检查可能跑一分钟以上，用流式累加避免被服务商掐断
        const content = await completeAccumulated(
          config,
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          {
            maxTokens: Math.max(config.maxTokens || 0, 4096),
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
          },
        );
        const report: ConsistencyReport = parseConsistencyReport(content, prompt.scope);

        /**
         * 把 high 级问题沉淀成「写作约束」，下一次生成正文时自动注入。
         * 检查不该只是一份看完就忘的报告——它得影响下一章怎么写。
         */
        const high = report.issues.filter((i) => i.severity === 'high');
        // 本次检查发现问题时全书已写到第几章：约束从「下一章」开始生效，
        // 这样用户回头重写旧章节时，不会被后文才出现的规则干扰。
        const nextOrder = chapters.reduce((max, c) => Math.max(max, c.order), -1) + 1;
        const synced = high.length
          ? addConstraints(
              project.id,
              null,
              high.map((i) => ({
                text: `${i.title}${i.suggestion ? `｜建议：${i.suggestion}` : ''}`.slice(0, 400),
                severity: 'high' as const,
              })),
              { applyFromOrder: nextOrder },
            )
          : 0;

        return { ...report, syncedConstraints: synced };
      } catch (e) {
        if (e instanceof AiError) {
          return reply.code(502).send({ error: 'check_failed', message: e.message });
        }
        const msg =
          (e as Error).name === 'TimeoutError'
            ? '检查超时，请减少章节数或重试。'
            : `检查失败：${(e as Error).message}`;
        return reply.code(502).send({ error: 'check_failed', message: msg });
      }
    },
  );
}

function badRequest(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, details: unknown) {
  return reply.code(400).send({ error: 'invalid_input', message: '参数校验失败', details });
}
