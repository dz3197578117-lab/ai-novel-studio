import type {
  DraftChapter,
  DraftEntity,
  DraftRequest,
  DraftVolume,
  EntityType,
  NovelDraft,
} from '@novelforge/shared';
import { AiError } from './client.js';

const VALID_TYPES: EntityType[] = ['world', 'character', 'faction', 'term', 'item', 'location'];

/** 构造「帮我策划一部小说」的提示词 */
export function buildDraftPrompt(req: DraftRequest): { system: string; user: string } {
  const chapterCount = clamp(req.chapterCount ?? 10, 3, 30);
  const system = `你是资深网络小说策划，擅长把一句话点子扩成可执行的创作方案。

只输出一个 JSON 对象，不要解释，不要 markdown 代码块，不要多余文字。

JSON 结构：
{
  "title": "书名，4-12 字，有吸引力，不要带『』",
  "logline": "一句话简介，30-60 字，说清主角、目标、阻力",
  "genre": "题材，如 古典玄幻 / 都市悬疑 / 科幻末世",
  "styleGuide": "文风要求，60-120 字，要具体：人称视角、语气、节奏、忌讳",
  "entities": [
    {
      "type": "character | world | faction | term | item | location",
      "name": "名称",
      "aliases": ["别名，可空数组"],
      "summary": "一句话说明，30 字内",
      "fields": [{ "key": "年龄", "value": "17" }],
      "body": "详细设定，50-200 字",
      "pinned": true
    }
  ],
  "volumes": [{ "title": "第一卷 · 卷名", "summary": "本卷概要，60-150 字" }],
  "chapters": [{ "volumeIndex": 0, "title": "第一章 · 章名", "outline": "本章梗概，60-120 字，必须有冲突或钩子" }]
}

硬性要求：
1. entities 至少 5 条，必须包含：主角、重要配角、对立势力、世界观条目；主角的 pinned 为 true，其余可为 false。
2. volumes 为 2-3 卷；每一卷都要有 chapters。
3. chapters 总数严格等于 ${chapterCount} 章，volumeIndex 从 0 开始，且不得超出 volumes 长度。
4. 所有人物姓名、地名、势力名保持一致，不要自相矛盾。
5. 内容必须贴合用户需求，不要写成通用套路。`;

  const lines = [`我的需求：${req.idea.trim()}`];
  if (req.genre?.trim()) lines.push(`题材倾向：${req.genre.trim()}`);
  lines.push(`目标章数：${chapterCount} 章`);
  return { system, user: lines.join('\n') };
}

/**
 * 解析模型输出为 NovelDraft。
 * 模型常会包代码块、加解释、类型写错，这里做清理与兜底。
 */
export function parseDraft(raw: string): NovelDraft {
  const text = String(raw ?? '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = text.indexOf('{');
  if (start < 0) {
    throw new AiError('模型没有返回可解析的方案，请重试或把需求描述得更具体一些。');
  }
  // 有闭合括号就截取中间的 JSON；只有开头没结尾时，交给 JSON.parse 报错
  const end = text.lastIndexOf('}');
  const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    throw new AiError('模型返回的方案格式有误（JSON 解析失败），请重试。');
  }

  return normalizeDraft(json);
}

function normalizeDraft(json: unknown): NovelDraft {
  if (!json || typeof json !== 'object') {
    throw new AiError('模型返回的方案结构不正确，请重试。');
  }
  const o = json as Record<string, unknown>;

  const title = str(o.title).slice(0, 60);
  if (!title) throw new AiError('模型没有给出书名，请重试。');

  const volumes: DraftVolume[] = arr(o.volumes)
    .slice(0, 4)
    .map((v) => ({
      title: str((v as Record<string, unknown>)?.title).slice(0, 100) || '未命名卷',
      summary: str((v as Record<string, unknown>)?.summary).slice(0, 2000),
    }));
  if (volumes.length === 0) volumes.push({ title: '第一卷', summary: '' });

  const chapters: DraftChapter[] = arr(o.chapters)
    .slice(0, 40)
    .map((c) => {
      const rec = c as Record<string, unknown>;
      const idx = Number(rec?.volumeIndex);
      return {
        volumeIndex:
          Number.isFinite(idx) && idx >= 0 && idx < volumes.length
            ? Math.floor(idx)
            : 0,
        title: str(rec?.title).slice(0, 100) || '未命名章节',
        outline: str(rec?.outline).slice(0, 3000),
      };
    });
  if (chapters.length === 0) {
    throw new AiError('模型没有给出章节大纲，请重试。');
  }

  const entities: DraftEntity[] = arr(o.entities)
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

  return {
    title,
    logline: str(o.logline).slice(0, 300),
    genre: str(o.genre).slice(0, 40),
    styleGuide: str(o.styleGuide).slice(0, 1000),
    entities,
    volumes,
    chapters,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}
