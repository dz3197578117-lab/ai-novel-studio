import type { FastifyInstance } from 'fastify';
import type {
  AiProviderConfig,
  DraftChapter,
  DraftVolume,
  InterviewMessage,
  NovelDraft,
  Project,
} from '@novelforge/shared';
import {
  CHAPTER_BATCH_SIZE,
  MAX_CHAPTERS,
  SINGLE_CALL_MAX_CHAPTERS,
  buildChapterBatchPrompt,
  buildChapterRegenPrompt,
  buildDraftPrompt,
  buildSkeletonPrompt,
  buildTitleBatchPrompt,
  buildVolumeChaptersPrompt,
  buildOutlineFillPrompt,
  parseChapterBatch,
  parseDraft,
  parseOutlineFill,
  parseRegeneratedChapter,
  parseSkeleton,
  parseTitleBatch,
  parseVolumeChapters,
  renumberChapterTitle,
  volumeCountFor,
} from '../ai/draft.js';
import { buildInterviewPrompt, parseInterviewResponse } from '../ai/interview.js';
import { AiError, complete, completeAccumulated, loadTextConfig } from '../ai/client.js';
import { createJob, getJob, patchJob, runJob } from '../services/jobs.js';
import { buildSettingBrief } from '../ai/briefing.js';
import { createProject, getProject } from '../repos/projects.repo.js';
import { createEntity } from '../repos/entities.repo.js';
import {
  createChapter,
  createVolume,
  getChapter,
  listChapters,
  listVolumes,
  updateChapter,
} from '../repos/chapters.repo.js';
import {
  draftRequestSchema,
  interviewRequest,
  novelDraftSchema,
  chapterRegenRequest,
  tocApply,
  tocRequest,
  expandVolumeRequest,
  applyVolumeChapters,
  fillOutlinesRequest,
} from './schemas.js';

/** 单次调用的超时时间（含重试等待） */
const DRAFT_CALL_TIMEOUT_MS = 180_000;
/** 单轮对话应该很快 */
const INTERVIEW_TIMEOUT_MS = 60_000;
/** 批次之间的间隔，避免连续打满服务商的 TPM 限流 */
const BATCH_DELAY_MS = 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 生成方案的输出预算。
 * 推理模型（如 deepseek-flash）的「思考」也吃 max_tokens，
 * 用配置里的 4096 会把正式内容挤掉，所以至少给到 8192。
 */
function draftBudget(config: AiProviderConfig): number {
  return Math.max(config.maxTokens || 0, 8192);
}

/** 把第 index 章分配到某一卷（按章数均分） */
function volumeIndexForChapter(index: number, total: number, volumeCount: number): number {
  if (volumeCount <= 1) return 0;
  const idx = Math.floor((index * volumeCount) / total);
  return Math.max(0, Math.min(volumeCount - 1, idx));
}

/** 章节数不多时：一次调用出完整方案 */
async function generateSingle(
  config: AiProviderConfig,
  req: { idea: string; genre?: string; chapterCount: number },
  chapterCount: number,
): Promise<NovelDraft> {
  const prompt = buildDraftPrompt({ ...req, chapterCount });
  // 用流式累加，避免长时间非流式请求被服务商掐断
  const content = await completeAccumulated(
    config,
    [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    { maxTokens: draftBudget(config), signal: AbortSignal.timeout(DRAFT_CALL_TIMEOUT_MS) },
  );

  try {
    return parseDraft(content);
  } catch (e) {
    throw new AiError(
      `${(e as Error).message}（如果反复失败，把规划章数调小一些再试）`,
    );
  }
}

/**
 * 章节数较多时：先出骨架，再分批写章节大纲。
 * 单次输出装不下 100 章，分批是唯一稳妥的办法。
 */
async function generateChunked(
  config: AiProviderConfig,
  req: { idea: string; genre?: string; chapterCount: number },
  chapterCount: number,
  onProgress?: (done: number, total: number, phase: string) => void,
  opts: { titlesOnly?: boolean } = {},
): Promise<NovelDraft> {
  const budget = draftBudget(config);
  const titlesOnly = Boolean(opts.titlesOnly);
  // 只要标题时输出短得多，一批可以写更多章
  const batchSize = titlesOnly ? 50 : CHAPTER_BATCH_SIZE;
  const batchTotal = Math.ceil(chapterCount / batchSize);

  // 1. 骨架
  const skPrompt = buildSkeletonPrompt({ ...req, chapterCount });
  onProgress?.(0, batchTotal, 'planning');
  const skContent = await completeAccumulated(
    config,
    [
      { role: 'system', content: skPrompt.system },
      { role: 'user', content: skPrompt.user },
    ],
    { maxTokens: budget, signal: AbortSignal.timeout(DRAFT_CALL_TIMEOUT_MS) },
  );
  const skeleton = parseSkeleton(skContent);

  // 保证卷数够用（模型可能少给）
  const wantVolumes = volumeCountFor(chapterCount);
  while (skeleton.volumes.length < wantVolumes) {
    skeleton.volumes.push({
      title: `第${skeleton.volumes.length + 1}卷`,
      summary: '',
    });
  }

  // 2. 分批写章节
  const chapters: DraftChapter[] = [];

  for (let start = 0, batch = 1; start < chapterCount; start += batchSize, batch++) {
    const count = Math.min(batchSize, chapterCount - start);
    const volumeIndexFor = Array.from({ length: count }, (_, i) =>
      volumeIndexForChapter(start + i, chapterCount, skeleton.volumes.length),
    );
    const prompt = titlesOnly
      ? buildTitleBatchPrompt({
          projectTitle: skeleton.title,
          logline: skeleton.logline,
          genre: req.genre ?? '',
          idea: req.idea,
          volumeTitles: skeleton.volumes.map((v) => v.title),
          volumeIndexFor,
          startNumber: start + 1,
          count,
          previousTitles: chapters.map((c) => c.title),
        })
      : buildChapterBatchPrompt({
          idea: req.idea,
          title: skeleton.title,
          logline: skeleton.logline,
          volumes: skeleton.volumes,
          volumeIndexFor,
          startNumber: start + 1,
          batchNumber: batch,
          batchTotal,
          previousTitles: chapters.map((c) => c.title),
        });

    const batchContent = await completeAccumulated(
      config,
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      { maxTokens: budget, signal: AbortSignal.timeout(DRAFT_CALL_TIMEOUT_MS) },
    );

    let got: DraftChapter[];
    try {
      got = titlesOnly
        ? parseTitleBatch(batchContent, skeleton.volumes.length)
        : parseChapterBatch(batchContent, skeleton.volumes.length);
    } catch (e) {
      throw new AiError(
        `第 ${batch}/${batchTotal} 批章节生成失败（${(e as Error).message}）。` +
          '可以重试，或把规划章数调小一些。',
      );
    }
    chapters.push(
      ...got.slice(0, count).map((c, i) => ({
        ...c,
        // 模型每批会从「第1章」重新数，这里统一成全书连续编号
        title: renumberChapterTitle(c.title, start + i),
      })),
    );

    // 批次之间稍等一下，别把服务商的每分钟额度打满
    if (start + batchSize < chapterCount) {
      await sleep(BATCH_DELAY_MS);
    }
    onProgress?.(batch, batchTotal, 'chapters');
  }

  return { ...skeleton, chapters };
}


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

    const chapterCount = Math.max(1, Math.min(MAX_CHAPTERS, parsed.data.chapterCount ?? 10));
    const request = { ...parsed.data, chapterCount };

    try {
      const draft =
        chapterCount <= SINGLE_CALL_MAX_CHAPTERS
          ? await generateSingle(config, request, chapterCount)
          : await generateChunked(config, request, chapterCount);
      return { draft };
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(502).send({ error: 'draft_failed', message: e.message });
      }
      const msg = (e as Error).name === 'TimeoutError'
        ? '生成超时，请减少章节数或重试。'
        : `生成失败：${(e as Error).message}`;
      return reply.code(502).send({ error: 'draft_failed', message: msg });
    }
  });

  // ── 单章大纲重生 ──
  app.post('/api/ai/regenerate-chapter', async (req, reply) => {
    const parsed = chapterRegenRequest.safeParse(req.body);
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

    try {
      const prompt = buildChapterRegenPrompt(parsed.data);
      const content = await completeAccumulated(
        config,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        { maxTokens: draftBudget(config), signal: AbortSignal.timeout(DRAFT_CALL_TIMEOUT_MS) },
      );
      const chapter = parseRegeneratedChapter(
        content,
        Math.max(1, parsed.data.volumes.length),
      );
      return { chapter };
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(502).send({ error: 'regen_failed', message: e.message });
      }
      const msg = (e as Error).name === 'TimeoutError'
        ? '重生成超时，请重试。'
        : `重生成失败：${(e as Error).message}`;
      return reply.code(502).send({ error: 'regen_failed', message: msg });
    }
  });

  /**
   * 为「已有作品」生成卷章目录（只预览，不落库）。
   * 复用整本生成的分批逻辑：把作品现有信息拼成需求，再走同一套 prompt。
   */
  app.post<{ Params: { id: string } }>('/api/projects/:id/generate-toc', async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });

    const parsed = tocRequest.safeParse(req.body ?? {});
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

    const chapterCount = Math.max(1, Math.min(MAX_CHAPTERS, parsed.data.chapterCount ?? 20));
    const existing = listChapters(project.id);

    // 把作品现有信息拼成「我要什么故事」的需求
    const ideaParts = [
      `书名：${project.title}`,
      project.logline ? `简介：${project.logline}` : '',
      project.genre ? `题材：${project.genre}` : '',
      project.styleGuide ? `文风：${project.styleGuide}` : '',
      project.brainstorm ? `作者的想法：\n${project.brainstorm.slice(0, 2000)}` : '',
      existing.length
        ? `已有章节（新目录要能接上，不要重复）：${existing
            .slice(0, 30)
            .map((c) => c.title)
            .join('、')}`
        : '',
      parsed.data.instruction ? `额外要求：${parsed.data.instruction}` : '',
      (() => {
        const brief = buildSettingBrief(project.id);
        return brief ? `作品现有设定（新目录必须与之相符）：\n${brief}` : '';
      })(),
    ].filter(Boolean);

    const request = {
      idea: ideaParts.join('\n'),
      genre: project.genre,
      chapterCount,
    };

    // 章数多时要跑几十分钟，单请求扛不住：改成后台任务 + 轮询
    const titlesOnly = Boolean(parsed.data.titlesOnly);
    const perBatch = titlesOnly ? 50 : CHAPTER_BATCH_SIZE;
    const batchTotal = Math.max(1, Math.ceil(chapterCount / perBatch));
    const job = createJob<{ volumes: DraftVolume[]; chapters: DraftChapter[] }>('toc', {
      phase: 'planning',
      done: 0,
      total: batchTotal,
      note: titlesOnly ? `只生成 ${chapterCount} 个章节名` : `计划生成 ${chapterCount} 章`,
    });

    runJob(job, async () => {
      const draft =
        !titlesOnly && chapterCount <= SINGLE_CALL_MAX_CHAPTERS
          ? await generateSingle(config, request, chapterCount)
          : await generateChunked(
              config,
              request,
              chapterCount,
              (done, total, phase) => patchJob(job.id, { progress: { done, total, phase } }),
              { titlesOnly },
            );
      return { volumes: draft.volumes, chapters: draft.chapters };
    });

    return reply.code(202).send({
      jobId: job.id,
      chapterCount,
      batches: batchTotal,
      titlesOnly,
      message: titlesOnly
        ? `已在后台生成 ${chapterCount} 个章节名（不含大纲），共 ${batchTotal} 批`
        : `已在后台生成，共 ${batchTotal} 批；可查看进度`,
    });
  });

  /**
   * 按卷扩展：只生成「某一卷」的章节，一卷一卷地把书扩到上千章。
   * 和整本生成一样走后台任务 + 轮询，避免长请求被掐断。
   */
  app.post<{ Params: { id: string } }>('/api/projects/:id/expand-volume', async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });

    const parsed = expandVolumeRequest.safeParse(req.body ?? {});
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

    const existing = listChapters(project.id);
    const volumes = listVolumes(project.id);
    const targetVolume = parsed.data.volumeId
      ? volumes.find((v) => v.id === parsed.data.volumeId)
      : null;
    const volumeTitle =
      targetVolume?.title?.replace(/\s+/g, ' ').trim() ||
      parsed.data.volumeTitle?.trim() ||
      `第${volumes.length + 1}卷`;
    const volumeSummary = parsed.data.volumeSummary ?? targetVolume?.summary ?? '';

    const count = Math.max(1, Math.min(300, parsed.data.chapterCount ?? 50));
    const startNumber = existing.length + 1;
    const titlesOnly = Boolean(parsed.data.titlesOnly);
    // 只要标题时一批可以写 50 章，快得多
    const batchSize = titlesOnly ? 50 : CHAPTER_BATCH_SIZE;
    const batchTotal = Math.ceil(count / batchSize);

    const idea = [
      `书名：${project.title}`,
      project.logline ? `简介：${project.logline}` : '',
      project.genre ? `题材：${project.genre}` : '',
      project.brainstorm ? `作者想法：${project.brainstorm.slice(0, 1500)}` : '',
      (() => {
        const brief = buildSettingBrief(project.id);
        return brief ? `作品现有设定（本卷不能与之冲突）：\n${brief}` : '';
      })(),
    ]
      .filter(Boolean)
      .join('\n');

    const job = createJob<
      { volumeTitle: string; volumeSummary: string; chapters: { title: string; outline: string }[] }
    >('volume', {
      phase: 'chapters',
      done: 0,
      total: batchTotal,
      note: `${volumeTitle} · 第 ${startNumber} 章起，共 ${count} 章${titlesOnly ? '（仅章节名）' : ''}`,
    });

    runJob(job, async () => {
      const chapters: { title: string; outline: string }[] = [];
      for (let batch = 0; batch < batchTotal; batch++) {
        const batchStart = startNumber + batch * batchSize;
        const batchCount = Math.min(batchSize, count - batch * batchSize);

        const prompt = titlesOnly
          ? buildTitleBatchPrompt({
              projectTitle: project.title,
              logline: project.logline,
              genre: project.genre,
              idea,
              volumeTitles: [volumeTitle],
              volumeIndexFor: Array.from({ length: batchCount }, () => 0),
              startNumber: batchStart,
              count: batchCount,
              previousTitles: [...existing.map((c) => c.title), ...chapters.map((c) => c.title)],
            })
          : buildVolumeChaptersPrompt({
              projectTitle: project.title,
              logline: project.logline,
              genre: project.genre,
              styleGuide: project.styleGuide,
              volumeTitle,
              volumeSummary,
              idea,
              startNumber: batchStart,
              count: batchCount,
              existingTitles: [...existing.map((c) => c.title), ...chapters.map((c) => c.title)],
              instruction: parsed.data.instruction,
            });

        const content = await completeAccumulated(
          config,
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          { maxTokens: draftBudget(config), signal: AbortSignal.timeout(DRAFT_CALL_TIMEOUT_MS) },
        );

        const parsedBatch = titlesOnly
          ? parseTitleBatch(content, 1).map((c) => ({ title: c.title, outline: '' }))
          : parseVolumeChapters(content);
        const got = parsedBatch.slice(0, batchCount);
        got.forEach((c, i) =>
          chapters.push({
            // 模型可能每批从「第1章」重数，这里统一成全书连续编号
            title: renumberChapterTitle(c.title, batchStart - 1 + i),
            outline: c.outline,
          }),
        );

        patchJob(job.id, {
          progress: { done: batch + 1, total: batchTotal, phase: 'chapters' },
        });
        if (batch + 1 < batchTotal) await sleep(BATCH_DELAY_MS);
      }
      return { volumeTitle, volumeSummary, chapters };
    });

    return reply.code(202).send({
      jobId: job.id,
      volumeTitle,
      startNumber,
      chapterCount: count,
      batches: batchTotal,
      titlesOnly,
    });
  });

  /** 把某卷生成的章节写入作品（追加到该卷末尾） */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/apply-volume-chapters',
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });

      const parsed = applyVolumeChapters.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_input',
          message: '章节数据不完整，无法写入',
          details: parsed.error.flatten(),
        });
      }

      const volumes = listVolumes(project.id);
      let volumeId = parsed.data.volumeId ?? null;
      // 指定了已存在的卷就用它，否则新建
      if (!volumeId || !volumes.some((v) => v.id === volumeId)) {
        const created = createVolume(
          project.id,
          parsed.data.volumeTitle,
          parsed.data.volumeSummary ?? '',
        );
        volumeId = created.id;
      }

      for (const c of parsed.data.chapters) {
        createChapter(project.id, {
          title: c.title,
          volumeId,
          outline: c.outline ?? '',
          content: '',
          status: 'outline',
        });
      }

      return reply.code(201).send({
        counts: { volumeId, chapters: parsed.data.chapters.length },
      });
    },
  );

  /**
   * 批量补全章节大纲：目录先只出名字，之后用这个把大纲补上。
   * 后台任务 + 进度，每批 10 章。
   */
  app.post<{ Params: { id: string } }>('/api/projects/:id/fill-outlines', async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });

    const parsed = fillOutlinesRequest.safeParse(req.body ?? {});
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

    const all = listChapters(project.id)
      .map((c) => getChapter(c.id))
      .filter((c): c is NonNullable<typeof c> => c !== null);

    const wantIds = parsed.data.ids?.length ? new Set(parsed.data.ids) : null;
    const onlyMissing = parsed.data.onlyMissing !== false;
    const targets = all.filter((c) => {
      if (wantIds) return wantIds.has(c.id);
      return onlyMissing ? !c.outline.trim() : true;
    });

    if (targets.length === 0) {
      return reply.code(400).send({
        error: 'nothing_to_do',
        message: '没有需要补大纲的章节（都已有大纲了）',
      });
    }

    const batchSize = 10;
    const batchTotal = Math.ceil(targets.length / batchSize);
    const job = createJob('outlines', {
      phase: 'chapters',
      done: 0,
      total: batchTotal,
      note: `补 ${targets.length} 章大纲`,
    });

    const idea = [
      `书名：${project.title}`,
      project.logline ? `简介：${project.logline}` : '',
      project.genre ? `题材：${project.genre}` : '',
      project.brainstorm ? `作者想法：${project.brainstorm.slice(0, 1200)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    runJob(job, async () => {
      let done = 0;
      const failed: string[] = [];
      const settingBrief = buildSettingBrief(project.id);
      for (let i = 0; i < targets.length; i += batchSize) {
        const batch = targets.slice(i, i + batchSize);
        const prompt = buildOutlineFillPrompt({
          projectTitle: project.title,
          logline: project.logline,
          genre: project.genre,
          styleGuide: project.styleGuide,
          idea,
          settingBrief,
          chapters: batch.map((c) => ({
            number: all.findIndex((x) => x.id === c.id) + 1,
            title: c.title,
          })),
          contextAround: all
            .slice(Math.max(0, i - 2), Math.min(all.length, i + batchSize + 2))
            .filter((x) => x.outline.trim())
            .map((x) => `${x.title}：${x.outline.slice(0, 80)}`)
            .join('\n'),
        });

        const content = await completeAccumulated(
          config,
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          { maxTokens: Math.max(config.maxTokens || 0, 4096), signal: AbortSignal.timeout(DRAFT_CALL_TIMEOUT_MS) },
        );

        const outlines = parseOutlineFill(content);
        batch.forEach((c, idx) => {
          const outline = outlines[idx];
          if (outline) updateChapter(c.id, { outline });
          else failed.push(c.title);
        });

        done += 1;
        patchJob(job.id, {
          progress: {
            done,
            total: batchTotal,
            phase: 'chapters',
            note: failed.length ? `${failed.length} 章未成功` : undefined,
          },
        });
        if (i + batchSize < targets.length) await sleep(BATCH_DELAY_MS);
      }
      return { filled: targets.length - failed.length, failed };
    });

    return reply.code(202).send({
      jobId: job.id,
      chapterCount: targets.length,
      batches: batchTotal,
    });
  });

  /** 单章补大纲（编辑器里点一下，几秒出结果） */
  app.post<{ Params: { id: string } }>('/api/chapters/:id/fill-outline', async (req, reply) => {
    const chapter = getChapter(req.params.id);
    if (!chapter) return reply.code(404).send({ error: 'not_found', message: '章节不存在' });
    const project = getProject(chapter.projectId);
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

    const all = listChapters(project.id)
      .map((c) => getChapter(c.id))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const idx = all.findIndex((c) => c.id === chapter.id);

    const prompt = buildOutlineFillPrompt({
      projectTitle: project.title,
      logline: project.logline,
      genre: project.genre,
      styleGuide: project.styleGuide,
      settingBrief: buildSettingBrief(project.id, { maxEntities: 30 }),
      idea: [
        project.logline,
        project.genre,
        project.brainstorm?.slice(0, 1200) ?? '',
      ]
        .filter(Boolean)
        .join('\n'),
      chapters: [{ number: idx + 1, title: chapter.title }],
      contextAround: all
        .slice(Math.max(0, idx - 3), idx + 4)
        .filter((c) => c.id !== chapter.id && c.outline.trim())
        .map((c) => `${c.title}：${c.outline.slice(0, 80)}`)
        .join('\n'),
    });

    try {
      const content = await completeAccumulated(
        config,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        { maxTokens: Math.max(config.maxTokens || 0, 4096), signal: AbortSignal.timeout(120_000) },
      );
      const [outline] = parseOutlineFill(content);
      if (!outline) {
        return reply.code(502).send({ error: 'empty', message: '模型没有给出大纲，请重试' });
      }
      return updateChapter(chapter.id, { outline });
    } catch (e) {
      if (e instanceof AiError) {
        return reply.code(502).send({ error: 'outline_failed', message: e.message });
      }
      return reply
        .code(502)
        .send({ error: 'outline_failed', message: `生成大纲失败：${(e as Error).message}` });
    }
  });

  /** 查询后台任务进度 / 结果 */
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not_found', message: '任务不存在或已过期' });
    return job;
  });

  /** 把预览确认后的目录写入现有作品（追加，不删除已有章节） */
  app.post<{ Params: { id: string } }>('/api/projects/:id/apply-toc', async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });

    const body = req.body as { volumes?: unknown; chapters?: unknown } | undefined;
    const parsed = tocApply.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '目录数据不完整，无法写入',
        details: parsed.error.flatten(),
      });
    }

    const volumeIds: string[] = [];
    for (const v of parsed.data.volumes ?? []) {
      const created = createVolume(project.id, v.title, v.summary ?? '');
      volumeIds.push(created.id);
    }

    let count = 0;
    for (const c of parsed.data.chapters) {
      const volumeId = volumeIds.length
        ? volumeIds[Math.min(c.volumeIndex, volumeIds.length - 1)] ?? null
        : null;
      createChapter(project.id, {
        title: c.title,
        volumeId,
        outline: c.outline ?? '',
        content: '',
        status: 'outline',
      });
      count++;
    }

    return reply.code(201).send({
      counts: { volumes: volumeIds.length, chapters: count },
    });
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
