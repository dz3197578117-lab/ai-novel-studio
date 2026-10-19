import type { FastifyInstance } from 'fastify';
import type { InterviewMessage, NovelDraft, Project } from '@novelforge/shared';
import { buildDraftPrompt, parseDraft } from '../ai/draft.js';
import { buildInterviewPrompt, parseInterviewResponse } from '../ai/interview.js';
import { AiError, complete, loadTextConfig } from '../ai/client.js';
import { createProject, getProject } from '../repos/projects.repo.js';
import { createEntity } from '../repos/entities.repo.js';
import { createChapter, createVolume } from '../repos/chapters.repo.js';
import { draftRequestSchema, interviewRequest, novelDraftSchema } from './schemas.js';

/** 整本小说生成最长等待时间：大模型出 10-30 章方案可能要一分多钟 */
const DRAFT_TIMEOUT_MS = 150_000;
/** 单轮对话应该很快 */
const INTERVIEW_TIMEOUT_MS = 60_000;

export async function draftRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 对话式需求访谈：AI 反问类型/主角/基调/篇幅，聊清楚后返回 brief。
   * 返回 done=true 后，前端再调 /api/ai/draft 生成方案。
   */
  app.post('/api/ai/interview', async (req, reply) => {
    const parsed = interviewRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
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

    const prompt = buildInterviewPrompt(parsed.data.messages as InterviewMessage[]);
    try {
      const raw = await complete(
        config,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        AbortSignal.timeout(INTERVIEW_TIMEOUT_MS),
      );
      return parseInterviewResponse(raw);
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(502).send({ error: 'interview_failed', message: e.message });
      }
      const msg =
        (e as Error).name === 'TimeoutError'
          ? '对话超时（超过 60 秒），请重试。'
          : `对话失败：${(e as Error).message}`;
      return reply.code(502).send({ error: 'interview_failed', message: msg });
    }
  });

  /**
   * 根据需求生成小说方案（不落库）。
   * 返回后由用户确认，再调 /api/projects/from-draft 创建。
   */
  app.post('/api/ai/draft', async (req, reply) => {
    const parsed = draftRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
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

    const prompt = buildDraftPrompt(parsed.data);
    try {
      const raw = await complete(
        config,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        AbortSignal.timeout(DRAFT_TIMEOUT_MS),
      );
      const draft = parseDraft(raw);
      return { draft };
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(502).send({ error: 'draft_failed', message: e.message });
      }
      const msg = (e as Error).name === 'TimeoutError'
        ? '生成超时（超过 150 秒），请减少章节数或重试。'
        : `生成失败：${(e as Error).message}`;
      return reply.code(502).send({ error: 'draft_failed', message: msg });
    }
  });

  /** 把确认后的方案落库成一部真正的作品 */
  app.post('/api/projects/from-draft', async (req, reply) => {
    const body = req.body as { draft?: unknown } | undefined;
    const parsed = novelDraftSchema.safeParse(body?.draft);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '方案数据不完整，无法创建',
        details: parsed.error.flatten(),
      });
    }
    const draft = parsed.data as NovelDraft;

    const project = createProject({
      title: draft.title,
      logline: draft.logline ?? '',
      genre: draft.genre ?? '',
      styleGuide: draft.styleGuide ?? '',
      status: 'drafting',
    });

    // 设定
    for (const e of draft.entities ?? []) {
      createEntity(project.id, {
        type: e.type,
        name: e.name,
        aliases: e.aliases,
        summary: e.summary,
        fields: e.fields,
        body: e.body,
        pinned: e.pinned,
      });
    }

    // 卷（记录下标到 id 的映射）
    const volumeIds: string[] = [];
    for (const v of draft.volumes ?? []) {
      const created = createVolume(project.id, v.title, v.summary ?? '');
      volumeIds.push(created.id);
    }

    // 章节
    for (const c of draft.chapters) {
      const volumeId =
        volumeIds.length > 0 ? (volumeIds[c.volumeIndex] ?? volumeIds[0] ?? null) : null;
      createChapter(project.id, {
        title: c.title,
        volumeId,
        outline: c.outline ?? '',
        content: '',
        status: 'outline',
      });
    }

    return reply.code(201).send({
      project: getProject(project.id) as Project,
      counts: {
        entities: draft.entities?.length ?? 0,
        volumes: volumeIds.length,
        chapters: draft.chapters.length,
      },
    });
  });
}
