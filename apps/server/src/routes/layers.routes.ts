import type { FastifyInstance } from 'fastify';
import type { SceneInput } from '@novelforge/shared';
import {
  clearScenes,
  createScene,
  deleteScene,
  listScenes,
  updateScene,
} from '../repos/layers.repo.js';
import { getChapter, listPriorSummaries, updateChapter } from '../repos/chapters.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { AiError, completeAccumulated, loadTextConfig } from '../ai/client.js';
import { buildSettingBrief } from '../ai/briefing.js';
import { buildBeatsPrompt, buildScenesPrompt, parseSceneCards } from '../ai/layers.js';
import { sceneInput } from './schemas.js';

const LAYER_TIMEOUT_MS = 120_000;

export async function layerRoutes(app: FastifyInstance): Promise<void> {
  // ── 场景卡 CRUD ──
  app.get<{ Params: { id: string } }>('/api/chapters/:id/scenes', async (req) => {
    return listScenes(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/chapters/:id/scenes', async (req, reply) => {
    const chapter = getChapter(req.params.id);
    if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
    const parsed = sceneInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    return reply.code(201).send(createScene(chapter.projectId, chapter.id, parsed.data));
  });

  app.patch<{ Params: { id: string } }>('/api/scenes/:id', async (req, reply) => {
    const parsed = sceneInput.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const updated = updateScene(req.params.id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'not_found', message: '场景不存在' });
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/scenes/:id', async (req, reply) => {
    const ok = deleteScene(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', message: '场景不存在' });
    return { ok: true };
  });

  // ── 大纲 → 细纲 ──
  app.post('/api/ai/chapter-beats', async (req, reply) => {
    const body = req.body as { projectId?: string; chapterId?: string } | undefined;
    const project = body?.projectId ? getProject(body.projectId) : null;
    const chapter = body?.chapterId ? getChapter(body.chapterId) : null;
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });

    let config;
    try {
      config = loadTextConfig();
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(412).send({ error: 'not_configured', message: e.message });
      }
      throw e;
    }

    const priors = listPriorSummaries(project.id, chapter.order, 3)
      .reverse()
      .map((p) => `${p.title}：${p.summary}`);
    const prompt = buildBeatsPrompt(project, chapter, priors, buildSettingBrief(project.id));

    try {
      const content = await completeAccumulated(
        config,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        {
          maxTokens: Math.max(config.maxTokens || 0, 2048),
          signal: AbortSignal.timeout(LAYER_TIMEOUT_MS),
        },
      );
      const beats = content.trim();
      if (!beats) return reply.code(502).send({ error: 'empty', message: '模型没有产出细纲' });
      updateChapter(chapter.id, { beats });
      return { beats };
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(502).send({ error: 'beats_failed', message: e.message });
      }
      return reply
        .code(502)
        .send({ error: 'beats_failed', message: `生成细纲失败：${(e as Error).message}` });
    }
  });

  // ── 细纲 → 场景卡（覆盖原有场景）──
  app.post('/api/ai/scene-cards', async (req, reply) => {
    const body = req.body as { projectId?: string; chapterId?: string } | undefined;
    const project = body?.projectId ? getProject(body.projectId) : null;
    const chapter = body?.chapterId ? getChapter(body.chapterId) : null;
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });

    let config;
    try {
      config = loadTextConfig();
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(412).send({ error: 'not_configured', message: e.message });
      }
      throw e;
    }

    const prompt = buildScenesPrompt(project, chapter, buildSettingBrief(project.id));
    try {
      const content = await completeAccumulated(
        config,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        {
          maxTokens: Math.max(config.maxTokens || 0, 4096),
          signal: AbortSignal.timeout(LAYER_TIMEOUT_MS),
        },
      );
      const scenes: SceneInput[] = parseSceneCards(content);
      clearScenes(chapter.id);
      const created = scenes.map((s) => createScene(project.id, chapter.id, s));
      return { scenes: created };
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(502).send({ error: 'scenes_failed', message: e.message });
      }
      return reply
        .code(502)
        .send({ error: 'scenes_failed', message: `生成场景卡失败：${(e as Error).message}` });
    }
  });
}
