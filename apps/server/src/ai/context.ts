import type { Chapter, MemoryUsage, Project, WriteMode } from '@novelforge/shared';
import { listPinnedEntities } from '../repos/entities.repo.js';
import { listPriorSummaries, listVolumes } from '../repos/chapters.repo.js';
import { listOpenForeshadows, listTimeline } from '../repos/consistency.repo.js';
import { listScenes, searchKnowledge } from '../repos/layers.repo.js';
import { scenesToText } from './layers.js';

export interface BuiltContext {
  system: string;
  user: string;
  memoryUsed: MemoryUsage[];
}

const MODE_INSTRUCTION: Record<WriteMode, string> = {
  continue:
    '请顺着已有正文自然续写，保持叙述视角、人称、语气、节奏完全一致。不要重复已有内容，不要写总结或评论，直接输出续写正文。',
  rewrite:
    '请改写用户选中的片段，保留原意与关键情节，改善表达、节奏与画面感。只输出改写后的片段，不要解释。',
  polish:
    '请润色用户提供的文本，修正语病、重复用词与生硬句式，提升文学性。只输出润色后的文本，不要解释。',
  expand:
    '请在不改变情节走向的前提下扩写用户提供的文本，补充细节、动作、心理与环境描写。只输出扩写后的文本。',
  style:
    '请严格模仿用户指定的文风样本进行写作：句式、用词、比喻密度、叙述距离都要贴近样本。直接输出正文。',
  chapter:
    '请根据本章大纲，写出**完整的一章正文**（约 2000-3000 字）：有起承转合，有场景、对话、动作与心理，结尾留钩子。不要输出章节标题，不要写提纲，不要解释，直接写正文。',
  'chapter-rewrite':
    '请**重写本章正文**：参考现有版本，但允许大幅调整情节编排、节奏与描写。要写完整的整章（约 2000-3000 字），不要只改写局部。不要输出章节标题，不要解释，直接输出重写后的完整正文。',
};

/** 这两个模式产出的是「整章正文」，前端会整段替换 */
export const CHAPTER_MODES: WriteMode[] = ['chapter', 'chapter-rewrite'];

/**
 * 组装生成上下文。核心目标：在 token 预算内塞入最有用的信息。
 * 优先级：本章大纲 > 固定设定 > 相邻前文 > 过往章节摘要 > 卷摘要
 */
export function buildContext(params: {
  project: Project;
  chapter: Chapter;
  mode: WriteMode;
  instruction?: string;
  selection?: string;
  memoryBudget?: number;
}): BuiltContext {
  const { project, chapter, mode, instruction, selection } = params;
  const budget = params.memoryBudget ?? 6000;
  const memoryUsed: MemoryUsage[] = [];
  let remaining = budget;

  const take = (kind: MemoryUsage['kind'], label: string, text: string): string | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const cost = trimmed.length;
    if (cost > remaining) return null;
    remaining -= cost;
    memoryUsed.push({ kind, label, chars: cost });
    return trimmed;
  };

  const blocks: string[] = [];

  // 1. 固定设定（人物/世界观等）
  const pinned = listPinnedEntities(project.id);
  if (pinned.length > 0) {
    const lines: string[] = [];
    for (const e of pinned) {
      const line = `- [${ENTITY_LABEL[e.type]}] ${e.name}${
        e.aliases.length ? `（又称：${e.aliases.join('、')}）` : ''
      }：${e.summary || e.body.slice(0, 120)}`;
      if (line.length <= remaining) {
        lines.push(line);
        remaining -= line.length;
      }
    }
    if (lines.length) {
      memoryUsed.push({ kind: 'entity', label: `${lines.length} 条固定设定`, chars: lines.join('\n').length });
      blocks.push(`## 世界观与人物设定\n${lines.join('\n')}`);
    }
  }

  // 2. 未回收的伏笔（长篇一致性的核心：让模型知道哪些坑还没填）
  const openForeshadows = listOpenForeshadows(project.id, 12);
  if (openForeshadows.length > 0) {
    const lines: string[] = [];
    for (const f of openForeshadows) {
      const line = `- ${f.title}${f.detail ? `：${f.detail.slice(0, 80)}` : ''}`;
      if (line.length > remaining) break;
      remaining -= line.length;
      lines.push(line);
    }
    if (lines.length) {
      memoryUsed.push({
        kind: 'entity',
        label: `${lines.length} 条未回收伏笔`,
        chars: lines.join('\n').length,
      });
      blocks.push(
        `## 尚未回收的伏笔（可以呼应或铺垫，但不要提前揭晓、也不要与已写内容矛盾）\n${lines.join('\n')}`,
      );
    }
  }

  // 3. 关键时间点（防止时间线前后矛盾）
  const keyEvents = listTimeline(project.id)
    .filter((t) => t.importance >= 2)
    .slice(0, 8);
  if (keyEvents.length > 0) {
    const lines = keyEvents.map(
      (t) => `- ${t.storyTime || '（未标时间）'}：${t.title}`,
    );
    const joined = lines.join('\n');
    if (joined.length <= remaining) {
      remaining -= joined.length;
      memoryUsed.push({ kind: 'style', label: `${lines.length} 条关键时间点`, chars: joined.length });
      blocks.push(`## 关键时间点（保持时间先后一致）\n${joined}`);
    }
  }

  // 4. 卷摘要
  if (chapter.volumeId) {
    const vol = listVolumes(project.id).find((v) => v.id === chapter.volumeId);
    const s = vol?.summary ? take('volume-summary', vol.title, vol.summary) : null;
    if (s) blocks.push(`## 本卷概要（${vol!.title}）\n${s}`);
  }

  // 3. 前情摘要（越近越重要，倒序取）
  const priors = listPriorSummaries(project.id, chapter.order, 30);
  if (priors.length > 0) {
    const picked: string[] = [];
    for (const p of priors) {
      const line = `- ${p.title}：${p.summary}`;
      if (line.length > remaining) break;
      remaining -= line.length;
      picked.unshift(`- ${p.title}：${p.summary}`);
    }
    if (picked.length) {
      memoryUsed.push({
        kind: 'chapter-summary',
        label: `前 ${picked.length} 章摘要`,
        chars: picked.join('\n').length,
      });
      blocks.push(`## 前情提要（按时间顺序）\n${picked.join('\n')}`);
    }
  }

  // 4. 章节大纲
  if (chapter.outline.trim()) {
    blocks.push(`## 本章大纲（必须遵守）\n${chapter.outline.trim()}`);
    memoryUsed.push({ kind: 'style', label: '本章大纲', chars: chapter.outline.length });
  }

  // 4.1 细纲（把大纲拆成节拍，层次更细）
  if (chapter.beats?.trim()) {
    blocks.push(`## 本章细纲（按这些节拍写，不要跳跃）\n${chapter.beats.trim()}`);
    memoryUsed.push({ kind: 'style', label: '本章细纲', chars: chapter.beats.length });
  }

  // 4.2 场景卡（目标-阻力-结果）
  const scenes = listScenes(chapter.id);
  if (scenes.length > 0) {
    const text = scenesToText(scenes);
    if (text.length <= remaining) {
      remaining -= text.length;
      blocks.push(`## 场景安排（按顺序推进）\n${text}`);
      memoryUsed.push({ kind: 'style', label: `${scenes.length} 个场景`, chars: text.length });
    }
  }

  // 4.3 作者资料（引用溯源：明确标出来自哪份资料）
  const hits = searchKnowledge(project.id, `${chapter.title} ${chapter.outline.slice(0, 200)}`, 3);
  if (hits.length > 0) {
    const lines = hits.map(
      (h) => `- 〔${h.docTitle}${h.source ? ` · ${h.source}` : ''}〕${h.text.slice(0, 300)}`,
    );
    const joined = lines.join('\n');
    if (joined.length <= remaining) {
      remaining -= joined.length;
      blocks.push(
        `## 作者资料（引用片段，以作者设定为准，不要自行改写其中的事实）\n${joined}`,
      );
      memoryUsed.push({
        kind: 'entity',
        label: `${hits.length} 条资料引用`,
        chars: joined.length,
      });
    }
  }

  // 5. 文风与硬约束
  const style = project.styleGuide.trim() || '自然流畅的中文小说叙述，克制而具体，避免辞藻堆砌。';
  blocks.push(`## 文风要求\n${style}`);

  const system = [
    `你是一位资深中文小说作家，正在为长篇小说《${project.title}》撰写正文。`,
    project.logline ? `作品简介：${project.logline}` : '',
    project.genre ? `题材类型：${project.genre}` : '',
    '',
    ...blocks,
    '',
    '## 硬性要求',
    '- 严格保持已有设定，不得擅自更改人物姓名、关系、能力与既定事实。',
    '- 不出现「作为AI」「以下是」之类的元叙述。',
    '- 直接输出小说正文，不要输出标题、序号或解释。',
    MODE_INSTRUCTION[mode],
  ]
    .filter((s) => s !== undefined)
    .join('\n');

  // 6. 用户消息：选区 / 已有正文 / 整章写作指令
  const userParts: string[] = [];
  const isChapterMode = CHAPTER_MODES.includes(mode);

  if (isChapterMode) {
    if (mode === 'chapter-rewrite' && chapter.content.trim()) {
      // 重写时给出原稿作参考，但明确允许推翻
      const reference =
        chapter.content.length > 6000
          ? chapter.content.slice(0, 6000) + '\n…（后略）'
          : chapter.content;
      userParts.push(`【现有版本（参考，允许大改）】\n${reference}`);
    } else {
      userParts.push('【开始写作】请根据本章大纲写出完整正文。');
    }
  } else if (selection && selection.trim()) {
    userParts.push(`【待处理文本】\n${selection.trim()}`);
  } else if (chapter.content.trim()) {
    const tail = tailByChars(chapter.content, 2500);
    userParts.push(`【本章已有正文（结尾部分）】\n${tail}`);
  }

  if (instruction && instruction.trim()) {
    userParts.push(`【额外要求】\n${instruction.trim()}`);
  }
  if (!userParts.length) {
    userParts.push('【开始写作】请根据大纲开始撰写本章正文。');
  }

  return { system, user: userParts.join('\n\n'), memoryUsed };
}

const ENTITY_LABEL: Record<string, string> = {
  world: '世界观',
  character: '人物',
  faction: '势力',
  term: '专有名词',
  item: '物品',
  location: '地点',
};

/** 从结尾按字数截取，尽量对齐段落边界 */
function tailByChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(text.length - maxChars);
  const nl = slice.indexOf('\n');
  return nl > 0 ? slice.slice(nl + 1) : slice;
}

/** 生成章节摘要的提示词 */
export function summaryPrompt(chapter: Chapter): { system: string; user: string } {
  return {
    system:
      '你是小说编辑助手。请把本章内容压缩成 150 字以内的剧情摘要，保留：出场人物、关键事件、状态变化、埋下的伏笔。只输出摘要正文，不要分点，不要评论。',
    user: `章节标题：${chapter.title}\n\n正文：\n${chapter.content.slice(0, 12000)}`,
  };
}
