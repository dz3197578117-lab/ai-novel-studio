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
import { getWebSearchConfig } from '../repos/settings.repo.js';
import { searchWeb } from '../services/websearch.js';

const FACT_TIMEOUT_MS = 90_000;
const SELF_FIX_TIMEOUT_MS = 120_000;

/** 让模型列核查点，并逐条检索作者资料 */
async function buildFacts(
  config: AiProviderConfig,
  project: Project,
  chapter: Chapter,
  useWeb: boolean,
): Promise<{ points: FactSheet['points']; hits: FactSheet['hits'] }> {
  const docs = listDocs(project.id);
  const prompt = buildFactPrompt({
    project,
    chapter,
    entities: listEntities(project.id),
    docs: docs.map((d) => ({ title: d.title, source: d.source })),
  });

  const askOnce = async (extra = '') =>
    completeAccumulated(
      config,
      [
        { role: 'system', content: prompt.system + extra },
        { role: 'user', content: prompt.user },
      ],
      {
        // 推理模型会把 token 花在思考上，1200 不够
        maxTokens: Math.min(Math.max(config.maxTokens || 0, 2048), 4000),
        signal: AbortSignal.timeout(FACT_TIMEOUT_MS),
      },
    );

  let raw = await askOnce();
  let points = parseFactPoints(raw);
  if (points.length === 0) {
    raw = await askOnce('\n\n注意：直接输出 JSON 对象本体，不要写思考过程。');
    points = parseFactPoints(raw);
  }
  if (points.length === 0) {
    throw new AiError('模型没有给出可用的核查点，请重试。');
  }
  const hits = retrieveHits(project.id, points);
  if (useWeb) {
    hits.push(...(await retrieveWebHits(points)));
  }
  return { points, hits };
}

/**
 * 联网补资料：只查「必查」项，最多 2 个，避免请求过慢。
 * 结果带 URL，页面里可点开核对；拿不到就返回空数组，让模型标「未覆盖」而不是编。
 */
async function retrieveWebHits(
  points: FactSheet['points'],
): Promise<FactSheet['hits']> {
  const targets = points.filter((p) => p.mustHave).slice(0, 2);
  const out: FactSheet['hits'] = [];
  for (const p of targets) {
    try {
      const results = await searchWeb(p.query, 3);
      for (const r of results) {
        // 过滤明显无关的结果（例如搜「内务府」混进的小说章节）
        if (!isRelevant(r, p.query)) continue;
        out.push({
          forPoints: [p.point],
          docTitle: `网络：${r.title}`,
          source: r.url,
          text: r.snippet,
          url: r.url,
          origin: 'web',
        });
      }
    } catch {
      /* 单个查询失败不影响整体 */
    }
    if (out.length >= 4) break;
  }
  return out;
}

/** 标题或摘要里至少命中一个查询词，才算相关 */
function isRelevant(r: { title: string; snippet: string }, query: string): boolean {
  const hay = `${r.title} ${r.snippet}`;
  const terms = new Set<string>();
  const cjk = query.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) terms.add(cjk.slice(i, i + 2));
  for (const w of query.match(/[A-Za-z0-9]{2,}/g) ?? []) terms.add(w);
  if (terms.size === 0) return true;
  let hit = 0;
  for (const t of terms) if (hay.includes(t)) hit++;
  // 命中两个词以上才算相关，避免单字巧合
  return hit >= 2;
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
  /** 手动联网检索（调试 / 「查一下这个说法」用） */
  app.post<{ Body: { query?: string; limit?: number } }>('/api/search/web', async (req, reply) => {
    const query = String(req.body?.query ?? '').trim();
    if (!query) return reply.code(400).send({ error: 'empty', message: '请输入查询内容' });
    if (!getWebSearchConfig().enabled) {
      return reply.code(412).send({ error: 'disabled', message: '联网查资料已在设置里关闭' });
    }
    const limit = Math.max(1, Math.min(8, Number(req.body?.limit ?? 5)));
    const results = await searchWeb(query, limit);
    return { results };
  });

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
  app.post<{ Params: { id: string }; Body: { web?: boolean } }>(
    '/api/chapters/:id/facts',
    async (req, reply) => {
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

      const useWeb = req.body?.web !== false && getWebSearchConfig().enabled;

      try {
        const { points, hits } = await buildFacts(config, project, chapter, useWeb);
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
    },
  );

  /**
   * AI 自查并整改：列核查点 → 自己检索资料 → 按资料改大纲/细纲。
   * body.apply=true 时直接写入章节；否则只返回结果，由作者决定是否采纳。
   */
  app.post<{ Params: { id: string }; Body: { apply?: boolean; web?: boolean } }>(
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

      const useWeb = req.body?.web !== false && getWebSearchConfig().enabled;

      try {
        // 没有核查点就先生成，避免作者还要先点一次「列事实清单」
        let points = chapter.facts ?? [];
        let hits: FactSheet['hits'];
        if (points.length === 0) {
          const built = await buildFacts(config, project, chapter, useWeb);
          points = built.points;
          hits = built.hits;
          setChapterFacts(chapter.id, points);
        } else {
          hits = retrieveHits(project.id, points);
          if (useWeb) hits.push(...(await retrieveWebHits(points)));
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
