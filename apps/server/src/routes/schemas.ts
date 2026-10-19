import { z } from 'zod';

export const projectInput = z.object({
  title: z.string().min(1, '标题不能为空').max(200),
  logline: z.string().max(500).optional(),
  genre: z.string().max(100).optional(),
  targetWords: z.number().int().min(0).max(100_000_000).optional(),
  status: z.enum(['drafting', 'paused', 'finished', 'archived']).optional(),
  styleGuide: z.string().max(4000).optional(),
});

export const entityInput = z.object({
  type: z.enum(['world', 'character', 'faction', 'term', 'item', 'location']),
  name: z.string().min(1).max(120),
  aliases: z.array(z.string().max(120)).max(20).optional(),
  summary: z.string().max(1000).optional(),
  fields: z
    .array(z.object({ key: z.string().max(60), value: z.string().max(2000) }))
    .max(50)
    .optional(),
  body: z.string().max(50_000).optional(),
  pinned: z.boolean().optional(),
});

export const chapterInput = z.object({
  title: z.string().min(1).max(200),
  volumeId: z.string().nullable().optional(),
  outline: z.string().max(20_000).optional(),
  content: z.string().max(2_000_000).optional(),
  status: z.enum(['outline', 'drafting', 'revising', 'done']).optional(),
});

export const volumeInput = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(20_000).optional(),
});

export const writeRequest = z.object({
  projectId: z.string().min(1),
  chapterId: z.string().min(1),
  mode: z.enum(['continue', 'rewrite', 'polish', 'expand', 'style']),
  instruction: z.string().max(4000).optional(),
  selection: z.string().max(200_000).optional(),
  memoryBudget: z.number().int().min(500).max(50_000).optional(),
});

/** 对话式需求访谈 */
export const interviewRequest = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(2000),
      }),
    )
    .min(1, '至少需要一条消息')
    .max(20),
});

/** 一套模型配置 */
export const profileInput = z.object({
  name: z.string().min(1, '给这套配置起个名字').max(60),
  baseUrl: z.string().max(500),
  model: z.string().max(200),
  // 允许空串（主动清空）；undefined 表示不修改
  apiKey: z.string().max(500).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
});

/** 拉取模型列表 / 测试连通性 */
export const fetchModelsInput = z.object({
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  profileId: z.string().max(100).optional(),
});

/** 图片模型配置 */
export const imageSettingsInput = z.object({
  baseUrl: z.string().max(500),
  apiKey: z.string().max(500).optional(),
  model: z.string().max(200),
});

export const exportRequest = z.object({
  format: z.enum(['txt', 'md', 'docx']),
  chapterIds: z.array(z.string()).optional(),
  includeOutline: z.boolean().optional(),
});

export const imageRequest = z.object({
  prompt: z.string().min(1).max(2000),
  size: z.string().optional(),
  kind: z.enum(['cover', 'illustration']).optional(),
  chapterId: z.string().nullable().optional(),
});

/** 让 AI 策划一部小说的需求 */
export const draftRequestSchema = z.object({
  idea: z.string().min(4, '请至少写几个字描述你想要的小说').max(2000),
  genre: z.string().max(60).optional(),
  /** 章数由用户自由填写，限制在可生成的范围内 */
  chapterCount: z.number().int().min(1).max(1000).optional(),
});

/**
 * 前端确认后回传的方案。
 * 结构由服务端生成，这里只做兜底校验，避免过于严格误伤。
 */
const draftEntitySchema = z.object({
  type: z.enum(['world', 'character', 'faction', 'term', 'item', 'location']),
  name: z.string().min(1).max(120),
  aliases: z.array(z.string().max(120)).max(10).optional(),
  summary: z.string().max(1000).optional(),
  fields: z
    .array(z.object({ key: z.string().max(60), value: z.string().max(2000) }))
    .max(20)
    .optional(),
  body: z.string().max(20_000).optional(),
  pinned: z.boolean().optional(),
});

export const novelDraftSchema = z.object({
  title: z.string().min(1).max(200),
  logline: z.string().max(500).optional(),
  genre: z.string().max(100).optional(),
  styleGuide: z.string().max(4000).optional(),
  entities: z.array(draftEntitySchema).max(20).optional(),
  volumes: z
    .array(z.object({ title: z.string().min(1).max(200), summary: z.string().max(20_000).optional() }))
    .max(20)
    .optional(),
  chapters: z
    .array(
      z.object({
        volumeIndex: z.number().int().min(0).max(30),
        title: z.string().min(1).max(200),
        outline: z.string().max(20_000).optional(),
      }),
    )
    .min(1, '至少需要一章')
    .max(1000, '章节数量超出限制'),
});
