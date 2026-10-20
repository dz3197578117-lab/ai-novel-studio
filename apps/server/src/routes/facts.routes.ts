import type { FastifyInstance } from 'fastify';
import type { FactSheet } from '@novelforge/shared';
import { buildFactPrompt, parseFactPoints } from '../ai/facts.js';
import { AiError, completeAccumulated, loadTextConfig } from '../ai/client.js';
import { getChapter, setChapterFacts } from '../repos/chapters.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { listEntities } from '../repos/entities.repo.js';
import { listDocs, searchKnowledge } from '../repos/layers.repo.js';

const FACT_TIMEOUT_MS = 90_000;

export async function factRoutes(app: FastifyInstance): Promise<void> {
  /** 读取本章已生成的事实核查点（不联网） */
  app.get<{ Params: { id: string } }>('/api/chapters/:id/facts', async (req, reply) => {
    const chapter = getChapter(req.params.id);
    if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
    return { points: chapter.facts ?? [] };
  });

  /**
   * 生成事实核查单：模型先列「本章写错就成硬伤的点」，再逐条检索作者资料。
   * 结果写回章节，下次生成正文时会用这些点去检索（而不是只用标题+大纲）。
   */
  app.post<{ Params: { id: string } }>('/api/chapters/:id/facts', async (req, reply) => {
    const chapter = getChapter(req.params.id);
    if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });

    const project = getProject(chapter.projectId);
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });

    if (!chapter.outline.trim() && !chapter.beats?.trim()) {
      return reply.code(400).send({
        error: 'empty',
        message: '本章还没有大纲，先写清这一章要发生什么，再查资料。',
      });
    }

    let config;
    try {
      config = loadTextConfig();
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(412).send({ error: 'not_configured', message: e.message });
      }
      throw e;
    }

    const docs = listDocs(project.id);
    const prompt = buildFactPrompt({
      project,
      chapter,
      entities: listEntities(project.id),
      docs: docs.map((d) => ({ title: d.title, source: d.source })),
    });

    try {
      const raw = await completeAccumulated(
        config,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        {
          maxTokens: 1200,
          signal: AbortSignal.timeout(FACT_TIMEOUT_MS),
        },
      );

      const points = parseFactPoints(raw);
      if (points.length === 0) {
        return reply.code(502).send({
          error: 'facts_failed',
          message: '模型没有给出可用的核查点，请重试。',
        });
      }

      // 逐条检索作者资料；同一片段被多条事实点命中时只保留一份，但记下全部关联点
      const byChunk = new Map<string, FactSheet['hits'][number]>();
      for (const p of points) {
        for (const h of searchKnowledge(project.id, p.query, 2)) {
          const key = `${h.docId}#${h.chunkIndex}`;
          const found = byChunk.get(key);
          if (found) {
            if (!found.forPoints.includes(p.point)) found.forPoints.push(p.point);
            continue;
          }
          byChunk.set(key, {
            forPoints: [p.point],
            docTitle: h.docTitle,
            source: h.source,
            text: h.text.slice(0, 400),
          });
          if (byChunk.size >= 12) break;
        }
        if (byChunk.size >= 12) break;
      }
      const hits = [...byChunk.values()];

      setChapterFacts(chapter.id, points);

      const sheet: FactSheet = {
        points,
        hits,
        generatedAt: new Date().toISOString(),
      };
      return sheet;
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(502).send({ error: 'facts_failed', message: e.message });
      }
      const msg =
        (e as Error).name === 'TimeoutError'
          ? '生成事实清单超时，请稍后重试。'
          : `生成失败：${(e as Error).message}`;
      return reply.code(502).send({ error: 'facts_failed', message: msg });
    }
  });
}
