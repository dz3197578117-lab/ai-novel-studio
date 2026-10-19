import type { FastifyInstance } from 'fastify';
import { AiError, completeAccumulated, loadTextConfig } from '../ai/client.js';
import { buildPlanRevisePrompt, cleanPlanOutput } from '../ai/plan.js';
import { getChapter, listChapters } from '../repos/chapters.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { listOpenForeshadows } from '../repos/consistency.repo.js';
import { planReviseInput } from './schemas.js';

const TIMEOUT_MS = 120_000;

export async function planRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 对本章大纲/细纲「提问」或「整改」。
   * ask 只回答不动文本；revise 返回改好的文本，由作者决定是否应用。
   */
  app.post('/api/ai/revise-plan', async (req, reply) => {
    const parsed = planReviseInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const { projectId, chapterId, field, mode, instruction } = parsed.data;

    const project = getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    const chapter = getChapter(chapterId);
    if (!chapter || chapter.projectId !== projectId) {
      return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
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

    // 前后各取一章，保证衔接
    const all = listChapters(project.id)
      .map((c) => getChapter(c.id))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const idx = all.findIndex((c) => c.id === chapter.id);
    const prev = idx > 0 ? all[idx - 1] ?? null : null;
    const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] ?? null : null;

    const prompt = buildPlanRevisePrompt({
      mode,
      field,
      project,
      chapter,
      prev,
      next,
      openForeshadows: listOpenForeshadows(project.id, 8).map((f) => f.title),
      instruction,
    });

    try {
      const raw = await completeAccumulated(
        config,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        {
          maxTokens: Math.max(config.maxTokens || 0, mode === 'ask' ? 2048 : 4096),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      const text = mode === 'ask' ? raw.trim() : cleanPlanOutput(raw, field);
      if (!text) {
        return reply.code(502).send({ error: 'empty', message: '模型没有返回内容，请重试' });
      }
      return { mode, field, text };
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(502).send({ error: 'revise_failed', message: e.message });
      }
      return reply
        .code(502)
        .send({ error: 'revise_failed', message: `处理失败：${(e as Error).message}` });
    }
  });
}
