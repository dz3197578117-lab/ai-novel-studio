import { z } from 'zod';

/**
 * 只接受 http(s) 地址。
 * baseUrl 决定了「你的正文会被发到哪里」，不校验协议等于允许用户把整本书
 * POST 到任意地址（file://、内网元数据地址等）。
 */
const httpUrl = z
  .string()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, '地址必须是 http:// 或 https:// 开头');

export const projectInput = z.object({
  title: z.string().min(1, '标题不能为空').max(200),
  logline: z.string().max(500).optional(),
  genre: z.string().max(100).optional(),
  targetWords: z.number().int().min(0).max(100_000_000).optional(),
  status: z.enum(['drafting', 'paused', 'finished', 'archived']).optional(),
  styleGuide: z.string().max(4000).optional(),
  brainstorm: z.string().max(100_000).optional(),
  rules: z.string().max(50_000).optional(),
  pov: z.enum(['auto', 'first', 'third-limited', 'third-omniscient', 'multi']).optional(),
  povNote: z.string().max(1000).optional(),
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
  beats: z.string().max(50_000).optional(),
  /** 本章视角覆盖；null = 继承项目默认 */
  pov: z
    .enum(['first', 'third-limited', 'third-omniscient', 'multi'])
    .nullable()
    .optional(),
  /** 乐观锁：前端保存时带上读取时的 updatedAt；不一致返回 409 */
  baseUpdatedAt: z.string().max(40).optional(),
  /** 版本快照原因：手动保存/AI 覆盖时强制留档 */
  snapshotReason: z.enum(['autosave', 'manual', 'ai-apply']).optional(),
});

/** 场景卡 */
export const sceneInput = z.object({
  title: z.string().min(1).max(120),
  pov: z.string().max(60).optional(),
  location: z.string().max(60).optional(),
  goal: z.string().max(500).optional(),
  conflict: z.string().max(500).optional(),
  outcome: z.string().max(500).optional(),
  keyLines: z.string().max(1000).optional(),
});

/** 知识库文档 */
export const knowledgeInput = z.object({
  title: z.string().min(1).max(200),
  source: z.string().max(300).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  content: z.string().min(1).max(500_000),
});

export const volumeInput = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(20_000).optional(),
});

export const writeRequest = z.object({
  projectId: z.string().min(1),
  chapterId: z.string().min(1),
  mode: z.enum([
    'continue',
    'rewrite',
    'polish',
    'expand',
    'style',
    'chapter',
    'chapter-rewrite',
  ]),
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

/** 单章大纲重生 */
export const chapterRegenRequest = z.object({
  idea: z.string().max(2000).optional(),
  title: z.string().min(1).max(200),
  logline: z.string().max(500).optional(),
  volumes: z
    .array(z.object({ title: z.string().max(200), summary: z.string().max(20_000) }))
    .max(20),
  chapters: z
    .array(
      z.object({
        volumeIndex: z.number().int().min(0).max(30),
        title: z.string().max(200),
        outline: z.string().max(20_000),
      }),
    )
    .min(1)
    .max(1000),
  index: z.number().int().min(0).max(999),
  instruction: z.string().max(1000).optional(),
});

/** 伏笔台账 */
export const foreshadowInput = z.object({
  title: z.string().min(1).max(120),
  detail: z.string().max(4000).optional(),
  plantedChapterId: z.string().nullable().optional(),
  plannedChapterId: z.string().nullable().optional(),
  recoveredChapterId: z.string().nullable().optional(),
  status: z.enum(['planted', 'recovered', 'abandoned']).optional(),
  importance: z.number().int().min(1).max(3).optional(),
});

/** 时间线事件 */
export const timelineInput = z.object({
  storyTime: z.string().max(120).optional(),
  title: z.string().min(1).max(120),
  detail: z.string().max(4000).optional(),
  chapterId: z.string().nullable().optional(),
  importance: z.number().int().min(1).max(3).optional(),
});

/** 为已有作品生成目录 */
export const tocRequest = z.object({
  chapterCount: z.number().int().min(1).max(1000).optional(),
  instruction: z.string().max(2000).optional(),
  /** 只生成章节名，不写大纲（快数倍，大纲可后期补） */
  titlesOnly: z.boolean().optional(),
});

/** 批量补全章节大纲 */
export const fillOutlinesRequest = z.object({
  ids: z.array(z.string()).max(1000).optional(),
  /** 只补大纲为空的章节（默认 true） */
  onlyMissing: z.boolean().optional(),
  instruction: z.string().max(2000).optional(),
});

/** 把目录写入作品 */
export const tocApply = z.object({
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
    .max(1000),
});

/** 按卷扩展：只生成某一卷的章节 */
export const expandVolumeRequest = z.object({
  volumeId: z.string().optional(),
  volumeTitle: z.string().max(200).optional(),
  /** 卷概要，新建卷时可以顺带写入 */
  volumeSummary: z.string().max(4000).optional(),
  chapterCount: z.number().int().min(1).max(300).optional(),
  instruction: z.string().max(2000).optional(),
  /** 只生成章节名，不写大纲 */
  titlesOnly: z.boolean().optional(),
});

/** 把某卷的章节写入作品 */
export const applyVolumeChapters = z.object({
  volumeId: z.string().optional(),
  volumeTitle: z.string().min(1).max(200),
  volumeSummary: z.string().max(4000).optional(),
  chapters: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        outline: z.string().max(20_000).optional(),
      }),
    )
    .min(1, '至少需要一章')
    .max(300),
});

/** 对大纲/细纲提问或整改 */
export const planReviseInput = z.object({
  projectId: z.string().min(1),
  chapterId: z.string().min(1),
  field: z.enum(['outline', 'beats']),
  mode: z.enum(['ask', 'revise']),
  instruction: z.string().min(1).max(4000),
});

/** 一套模型配置 */
export const profileInput = z.object({
  name: z.string().min(1, '给这套配置起个名字').max(60),
  baseUrl: httpUrl,
  model: z.string().max(200),
  // 允许空串（主动清空）；undefined 表示不修改
  apiKey: z.string().max(500).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
});

/** 拉取模型列表 / 测试连通性 */
export const fetchModelsInput = z.object({
  baseUrl: httpUrl.optional(),
  apiKey: z.string().max(500).optional(),
  profileId: z.string().max(100).optional(),
});

/** 图片模型配置：允许空串表示清空 */
export const imageSettingsInput = z.object({
  baseUrl: z.union([z.literal(''), httpUrl]),
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
  pov: z.enum(['first', 'third-limited', 'third-omniscient', 'multi']).optional(),
  povNote: z.string().max(500).optional(),
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
