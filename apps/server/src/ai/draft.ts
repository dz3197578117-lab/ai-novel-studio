import type {
  DraftChapter,
  DraftEntity,
  DraftRequest,
  DraftVolume,
  EntityType,
  NovelDraft,
} from '@novelforge/shared';
import { AiError } from './client.js';

/** 章数上限。网文常见几百上千章，所以放宽到 1000 */
const MIN_CHAPTERS = 1;
export const MAX_CHAPTERS = 1000;

/** 一次调用能稳妥装下的章节数；超过就分批生成 */
export const SINGLE_CALL_MAX_CHAPTERS = 10;
/** 分批时每批多少章。20 章 ≈ 2000 token，给 8192 预算留足思考空间 */
export const CHAPTER_BATCH_SIZE = 20;

/** 每卷大致放多少章 */
const CHAPTERS_PER_VOLUME = 40;
/** 卷数上限，避免 1000 章被切成上百卷 */
const MAX_VOLUMES = 20;

/** 提示词里最多带多少条「已写章节」，防止历史撑爆上下文 */
const MAX_PREVIOUS_TITLES = 15;

const JSON_RULES = `只输出一个 JSON 对象，不要解释，不要 markdown 代码块，不要多余文字。
文字要紧凑：outline 40-90 字，body 40-120 字，写清冲突与钩子即可，不要铺陈。`;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** 按每卷约 40 章推算卷数（100 章 → 3 卷，1000 章 → 20 卷） */
export function volumeCountFor(chapterCount: number): number {
  return clamp(Math.ceil(chapterCount / CHAPTERS_PER_VOLUME), 1, MAX_VOLUMES);
}

// ───────────────────────── 提示词 ─────────────────────────

/** 单次生成整份方案（章节不多时用） */
export function buildDraftPrompt(req: DraftRequest): { system: string; user: string } {
  const chapterCount = clamp(req.chapterCount ?? 10, MIN_CHAPTERS, MAX_CHAPTERS);
  const volumeCount = volumeCountFor(chapterCount);

  const system = `你是资深网络小说策划，擅长把一句话点子扩成可执行的创作方案。

${JSON_RULES}

JSON 结构：
{
  "title": "书名，4-12 字",
  "logline": "一句话简介，30-60 字",
  "genre": "题材",
  "styleGuide": "文风要求，60-120 字",
  "entities": [{ "type": "character|world|faction|term|item|location", "name": "名称", "aliases": [], "summary": "一句话", "fields": [{ "key": "年龄", "value": "17" }], "body": "详细设定", "pinned": true }],
  "volumes": [{ "title": "第一卷 · 卷名", "summary": "本卷概要" }],
  "chapters": [{ "volumeIndex": 0, "title": "第一章 · 章名", "outline": "本章梗概" }]
}

硬性要求：
1. entities 至少 4 条，含主角（pinned 为 true）、对立势力、世界观条目。
2. volumes 为 ${volumeCount} 卷，每卷都要有章节。
3. chapters 总数严格等于 ${chapterCount} 章，volumeIndex 从 0 开始且不超过 ${volumeCount - 1}。
4. 人物、地名、势力名前后一致。
5. 贴合用户需求，不要写成通用套路。`;

  const lines = [`我的需求：${req.idea.trim()}`];
  if (req.genre?.trim()) lines.push(`题材倾向：${req.genre.trim()}`);
  lines.push(`目标章数：${chapterCount} 章`);
  return { system, user: lines.join('\n') };
}

/** 第一步：只出骨架（书名/简介/文风/设定/分卷），不含章节 */
export function buildSkeletonPrompt(req: DraftRequest): { system: string; user: string } {
  const chapterCount = clamp(req.chapterCount ?? 10, MIN_CHAPTERS, MAX_CHAPTERS);
  const volumeCount = volumeCountFor(chapterCount);

  const system = `你是资深网络小说策划。先为一部书定骨架：书名、简介、文风、核心设定、分卷。
章节大纲稍后单独生成，这次**不要输出 chapters**。

${JSON_RULES}

JSON 结构：
{
  "title": "书名，4-12 字",
  "logline": "一句话简介，30-60 字",
  "genre": "题材",
  "styleGuide": "文风要求，60-120 字",
  "entities": [{ "type": "character|world|faction|term|item|location", "name": "名称", "aliases": [], "summary": "一句话", "fields": [{ "key": "年龄", "value": "17" }], "body": "详细设定", "pinned": true }],
  "volumes": [{ "title": "第一卷 · 卷名", "summary": "本卷概要，40-80 字" }]
}

硬性要求：
1. entities 至少 4 条，含主角（pinned 为 true）、对立势力、世界观条目。
2. volumes 恰好 ${volumeCount} 卷，卷概要要能看出来剧情推进。`;

  const lines = [`我的需求：${req.idea.trim()}`];
  if (req.genre?.trim()) lines.push(`题材倾向：${req.genre.trim()}`);
  lines.push(`全书计划 ${chapterCount} 章，分 ${volumeCount} 卷`);
  return { system, user: lines.join('\n') };
}

/** 第二步：按批次生成章节大纲 */
export function buildChapterBatchPrompt(params: {
  idea: string;
  title: string;
  logline: string;
  volumes: { title: string; summary: string }[];
  volumeIndexFor: number[];
  /** 本批第一个章节的全局序号（从 1 开始） */
  startNumber: number;
  batchNumber: number;
  batchTotal: number;
  previousTitles: string[];
}): { system: string; user: string } {
  const {
    idea,
    title,
    logline,
    volumes,
    volumeIndexFor,
    startNumber,
    batchNumber,
    batchTotal,
    previousTitles,
  } = params;

  const volumeLines = volumes
    .map((v, i) => `${i}. ${v.title}：${v.summary}`)
    .join('\n');
  const assignment = volumeIndexFor
    .map(
      (vi, i) =>
        `第 ${startNumber + i} 章 → volumeIndex ${vi}（${volumes[vi]?.title ?? ''}）`,
    )
    .join('\n');

  const system = `你在为网络小说《${title}》编写章节大纲。
作品一句话简介：${logline}
全书分卷：
${volumeLines}

这次只写指定范围内的章节，不要重复已写过的章节，也不要写这范围之外的章节。

${JSON_RULES}

JSON 结构：
{ "chapters": [{ "volumeIndex": 0, "title": "第X章 · 章名", "outline": "本章梗概，40-90 字，必须有冲突或钩子" }] }

硬性要求：
1. 只输出 ${volumeIndexFor.length} 个章节，标题里的章号必须严格使用下面给出的编号（是全书连续编号，不是从 1 重新数）。
2. volumeIndex 必须严格使用给定值。
3. 前后衔接自然，不要与已写章节重复。`;

  // 只带最近若干章的标题：几百上千章时全量塞进去会把上下文撑爆
  const recent = previousTitles.slice(-MAX_PREVIOUS_TITLES);
  const prev = recent.length
    ? `已写过的最近 ${recent.length} 章（不要重复这些内容，接着往后写）：\n${recent
        .map((t) => `- ${t}`)
        .join('\n')}`
    : '这是第一批，还没有已写章节。';
  const omitted =
    previousTitles.length > recent.length
      ? `\n（更早的 ${previousTitles.length - recent.length} 章已省略，无需重复它们的内容）`
      : '';

  const user = `创作需求：${idea}

本次是第 ${batchNumber}/${batchTotal} 批。

请写以下章节：
${assignment}

${prev}${omitted}`;

  return { system, user };
}

// ───────────────────────── 解析 ─────────────────────────

/** 取出文本里的 JSON 对象；模型常包代码块或加解释 */
function extractObject(text: string): string {
  const cleaned = String(text ?? '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  if (start < 0) {
    throw new AiError('模型没有返回可解析的方案，请重试或把需求描述得更具体一些。');
  }
  const end = cleaned.lastIndexOf('}');
  return end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
}

/**
 * 尝试修复被 max_tokens 截断的 JSON：
 * 退到最后一个「完整元素」的位置，再补上缺失的括号。
 */
export function repairTruncatedJson(text: string): unknown | null {
  const cleaned = String(text ?? '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  const s = cleaned.slice(start);

  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let lastSafe = -1;

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === '{' || c === '[') {
      stack.push(c);
    } else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) {
        try {
          return JSON.parse(s.slice(0, i + 1));
        } catch {
          return null;
        }
      }
      // 内层对象/数组闭合，是一个安全的截断点
      lastSafe = i;
    }
  }

  if (lastSafe < 0) return null;

  const head = s.slice(0, lastSafe + 1);
  // 重新算出 head 结束时的括号栈
  const stack2: string[] = [];
  let inStr2 = false;
  let esc2 = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i]!;
    if (inStr2) {
      if (esc2) esc2 = false;
      else if (c === '\\') esc2 = true;
      else if (c === '"') inStr2 = false;
      continue;
    }
    if (c === '"') inStr2 = true;
    else if (c === '{' || c === '[') stack2.push(c);
    else if (c === '}' || c === ']') stack2.pop();
  }

  const closers = stack2
    .reverse()
    .map((c) => (c === '{' ? '}' : ']'))
    .join('');

  try {
    return JSON.parse(head + closers);
  } catch {
    return null;
  }
}

function parseObject(raw: string): Record<string, unknown> {
  const candidate = extractObject(raw);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // 可能是被截断，尝试修复
    const repaired = repairTruncatedJson(raw);
    if (repaired && typeof repaired === 'object') {
      return repaired as Record<string, unknown>;
    }
    throw new AiError('模型返回的方案格式有误（可能输出被截断），请减少章节数或重试。');
  }
  throw new AiError('模型返回的方案结构不正确，请重试。');
}

const VALID_TYPES: EntityType[] = ['world', 'character', 'faction', 'term', 'item', 'location'];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function normalizeEntities(raw: unknown): DraftEntity[] {
  return arr(raw)
    .slice(0, 12)
    .map((e) => {
      const rec = e as Record<string, unknown>;
      const type = str(rec?.type) as EntityType;
      return {
        type: VALID_TYPES.includes(type) ? type : 'character',
        name: str(rec?.name).slice(0, 60) || '未命名',
        aliases: arr(rec?.aliases).map((a) => str(a)).filter(Boolean).slice(0, 8),
        summary: str(rec?.summary).slice(0, 500),
        fields: arr(rec?.fields)
          .map((f) => {
            const fr = f as Record<string, unknown>;
            return { key: str(fr?.key).slice(0, 40), value: str(fr?.value).slice(0, 500) };
          })
          .filter((f) => f.key)
          .slice(0, 12),
        body: str(rec?.body).slice(0, 4000),
        pinned: rec?.pinned === true,
      };
    });
}

function normalizeVolumes(raw: unknown): DraftVolume[] {
  const list = arr(raw)
    .slice(0, MAX_VOLUMES)
    .map((v) => ({
      title: str((v as Record<string, unknown>)?.title).slice(0, 100) || '未命名卷',
      summary: str((v as Record<string, unknown>)?.summary).slice(0, 2000),
    }));
  if (list.length === 0) list.push({ title: '第一卷', summary: '' });
  return list;
}

function normalizeChapters(raw: unknown, volumeCount: number): DraftChapter[] {
  return arr(raw)
    .slice(0, MAX_CHAPTERS)
    .map((c) => {
      const rec = c as Record<string, unknown>;
      const idx = Number(rec?.volumeIndex);
      return {
        volumeIndex:
          Number.isFinite(idx) && idx >= 0 && idx < volumeCount ? Math.floor(idx) : 0,
        title: str(rec?.title).slice(0, 100) || '未命名章节',
        outline: str(rec?.outline).slice(0, 3000),
      };
    });
}

/** 解析完整的方案（单次生成） */
export function parseDraft(raw: string): NovelDraft {
  const o = parseObject(raw);
  const title = str(o.title).slice(0, 60);
  if (!title) throw new AiError('模型没有给出书名，请重试。');
  const volumes = normalizeVolumes(o.volumes);
  const chapters = normalizeChapters(o.chapters, volumes.length);
  if (chapters.length === 0) throw new AiError('模型没有给出章节大纲，请重试。');

  return {
    title,
    logline: str(o.logline).slice(0, 300),
    genre: str(o.genre).slice(0, 40),
    styleGuide: str(o.styleGuide).slice(0, 1000),
    entities: normalizeEntities(o.entities),
    volumes,
    chapters,
  };
}

export interface DraftSkeleton {
  title: string;
  logline: string;
  genre: string;
  styleGuide: string;
  entities: DraftEntity[];
  volumes: DraftVolume[];
}

/** 解析骨架（分批模式第一步） */
export function parseSkeleton(raw: string): DraftSkeleton {
  const o = parseObject(raw);
  const title = str(o.title).slice(0, 60);
  if (!title) throw new AiError('模型没有给出书名，请重试。');
  return {
    title,
    logline: str(o.logline).slice(0, 300),
    genre: str(o.genre).slice(0, 40),
    styleGuide: str(o.styleGuide).slice(0, 1000),
    entities: normalizeEntities(o.entities),
    volumes: normalizeVolumes(o.volumes),
  };
}

/** 解析某一批章节 */
export function parseChapterBatch(raw: string, volumeCount: number): DraftChapter[] {
  const o = parseObject(raw);
  const chapters = normalizeChapters(o.chapters, volumeCount);
  if (chapters.length === 0) {
    throw new AiError('模型没有产出这一批章节，请重试。');
  }
  return chapters;
}

const CN_NUM = '[0-9一二三四五六七八九十百]+';

/**
 * 把章节标题里的序号改写成全书统一编号。
 * 分批生成时模型常会每批从「第1章」重新数，这里统一纠正，
 * 只保留标题里的名字部分。
 */
export function renumberChapterTitle(title: string, index: number): string {
  const n = index + 1;
  const stripped = title
    .replace(new RegExp(`^\\s*第\\s*${CN_NUM}\\s*章\\s*[·・、.．:：\\-—]*\\s*`), '')
    .trim();
  return stripped ? `第${n}章 · ${stripped}` : `第${n}章`;
}

// ───────────────────────── 单章大纲重生 ─────────────────────────

/** 构造「只重做某一章」的提示词，带上前后章节保证衔接 */
export function buildChapterRegenPrompt(req: {
  idea?: string;
  title: string;
  logline?: string;
  volumes: { title: string; summary: string }[];
  chapters: { volumeIndex: number; title: string; outline: string }[];
  index: number;
  instruction?: string;
}): { system: string; user: string } {
  const target = req.chapters[req.index];
  if (!target) {
    throw new AiError('要重做的章节不存在。');
  }
  const n = req.index + 1;
  const volume = req.volumes[target.volumeIndex];

  const neighborLines = req.chapters
    .map((c, i) => {
      if (i === req.index) return null;
      const mark = Math.abs(i - req.index) <= 2 ? '（相邻）' : '';
      return `- 第${i + 1}章 ${c.title}：${c.outline}${mark}`;
    })
    .filter(Boolean)
    .join('\n');

  const system = `你在为网络小说《${req.title}》单独重做**第 ${n} 章**的大纲。
${req.logline ? `作品简介：${req.logline}` : ''}
${volume ? `本章所属：${volume.title}——${volume.summary}` : ''}

其他章节（用来保证前后衔接，不要重复它们的情节）：
${neighborLines}

要求：
- 只输出第 ${n} 章这一章，**不要**输出其它章节。
- 新大纲要能和上一章结尾接上，并给下一章留钩子；不要与相邻章节撞情节。
- 比原来的版本更有冲突和看点。

${JSON_RULES}

JSON 结构：
{ "volumeIndex": ${target.volumeIndex}, "title": "第${n}章 · 章名", "outline": "本章梗概，40-90 字" }`;

  const userParts = [`创作需求：${req.idea?.trim() || '（未提供，按书名与现有章节推断）'}`];
  userParts.push(
    `原来的第 ${n} 章（不满意，需要重做）：\n标题：${target.title}\n大纲：${target.outline}`,
  );
  if (req.instruction?.trim()) {
    userParts.push(`这次的要求：${req.instruction.trim()}`);
  }

  return { system, user: userParts.join('\n\n') };
}

/** 解析单章重生的结果 */
export function parseRegeneratedChapter(raw: string, volumeCount: number): DraftChapter {
  const o = parseObject(raw);
  const idx = Number(o.volumeIndex);
  return {
    volumeIndex:
      Number.isFinite(idx) && idx >= 0 && idx < volumeCount ? Math.floor(idx) : 0,
    title: str(o.title).slice(0, 100) || '未命名章节',
    outline: str(o.outline).slice(0, 3000),
  };
}
