import type { FastifyInstance } from 'fastify';
import type { AiProviderConfig, Chapter, FactSheet, Project, SelfFixResult } from '@novelforge/shared';
import {
  buildFactPrompt,
  buildSelfFixPrompt,
  parseFactPoints,
  parseSelfFix,
} from '../ai/facts.js';
import { AiError, completeAccumulated, loadTextConfig } from '../ai/client.js';
import { getChapter, setChapterFacts, updateChapter } from '../repos/chapters.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { listEntities } from '../repos/entities.repo.js';
import { listDocs, searchKnowledge } from '../repos/layers.repo.js';

const FACT_TIMEOUT_MS = 90_000;
const SELF_FIX_TIMEOUT_MS = 120_000;

/** 让模型列核查点，并逐条检索作者资料 */
async function buildFacts(
  config: AiProviderConfig,
  project: Project,
  chapter: Chapter,
): Promise<{ points: FactSheet['points']; hits: FactSheet['hits'] }> {
  const docs = listDocs(project.id);
  const prompt = buildFactPrompt({
    project,
    chapter,
    entities: listEntities(project.id),
    docs: docs.map((d) => ({ title: d.title, source: d.source })),
  });

  const raw = await completeAccumulated(
    config,
    [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    { maxTokens: 1200, signal: AbortSignal.timeout(FACT_TIMEOUT_MS) },
  );

  const points = parseFactPoints(raw);
  if (points.length === 0) {
    throw new AiError('模型没有给出可用的核查点，请重试。');
  }
  return { points, hits: retrieveHits(project.id, points) };
}

/** 逐条检索；同一片段被多个事实点命中时只保留一份，但记下全部关联点 */
function retrieveHits(projectId: string, points: FactSheet['points']): FactSheet['hits'] {
  const byChunk = new Map<string, FactSheet['hits'][number]>();
  for (const p of points) {
    for (const h of searchKnowledge(projectId, p.query, 2)) {
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
  return [...byChunk.values()];
}

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

    try {
      const { points, hits } = await buildFacts(config, project, chapter);
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

  /**
   * AI 自查并整改：列核查点 → 自己检索资料 → 按资料改大纲/细纲。
   * body.apply=true 时直接写入章节；否则只返回结果，由作者决定是否采纳。
   */
  app.post<{ Params: { id: string }; Body: { apply?: boolean } }>(
    '/api/chapters/:id/self-fix',
    async (req, reply) => {
      const chapter = getChapter(req.params.id);
      if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });

      const project = getProject(chapter.projectId);
      if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });

      if (!chapter.outline.trim() && !chapter.beats?.trim()) {
        return reply.code(400).send({
          error: 'empty',
          message: '本章还没有大纲，先写大纲再用自查整改。',
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

      try {
        // 没有核查点就先生成，避免作者还要先点一次「列事实清单」
        let points = chapter.facts ?? [];
        let hits: FactSheet['hits'];
        if (points.length === 0) {
          const built = await buildFacts(config, project, chapter);
          points = built.points;
          hits = built.hits;
          setChapterFacts(chapter.id, points);
        } else {
          hits = retrieveHits(project.id, points);
        }

        const prompt = buildSelfFixPrompt({
          project,
          chapter,
          entities: listEntities(project.id),
          points,
          hits,
        });

        // 推理模型会把 token 花在思考上，输出预算给足；解析失败时重试一次
        const askOnce = async (extra = '') => {
          const raw = await completeAccumulated(
            config,
            [
              { role: 'system', content: prompt.system + extra },
              { role: 'user', content: prompt.user },
            ],
            {
              maxTokens: Math.min(Math.max(config.maxTokens || 0, 4096), 8000),
              signal: AbortSignal.timeout(SELF_FIX_TIMEOUT_MS),
            },
          );
          return raw;
        };

        let raw = await askOnce();
        let result: SelfFixResult;
        try {
          result = parseSelfFix(raw);
        } catch {
          // 再试一次，明确要求直接输出 JSON
          raw = await askOnce('\n\n注意：直接输出 JSON 对象本体，不要写任何思考过程或解释文字。');
          try {
            result = parseSelfFix(raw);
          } catch {
            throw new AiError(
              `模型没有返回可解析的整改结果（输出开头：${raw.slice(0, 160).replace(/\s+/g, ' ')}）`,
            );
          }
        }
        result.hitCount = hits.length;

        // 模型没给 outline 时保留原值，避免把大纲清空
        if (!result.outline) result.outline = chapter.outline;
        if (!result.beats) result.beats = chapter.beats ?? '';

        const apply = Boolean(req.body?.apply);
        if (apply) {
          updateChapter(chapter.id, {
            outline: result.outline,
            beats: result.beats,
          });
        }

        return { ...result, applied: apply };
      } catch (e) {
        if (e instanceof AiError) {
          return reply.code(502).send({ error: 'self_fix_failed', message: e.message });
        }
        const msg =
          (e as Error).name === 'TimeoutError'
            ? '自查整改超时，请稍后重试。'
            : `自查整改失败：${(e as Error).message}`;
        return reply.code(502).send({ error: 'self_fix_failed', message: msg });
      }
    },
  );
}
