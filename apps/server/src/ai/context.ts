import type { Chapter, MemoryUsage, Project, WriteMode } from '@novelforge/shared';
import { listPinnedEntities } from '../repos/entities.repo.js';
import { listPriorSummaries, listVolumes } from '../repos/chapters.repo.js';
import { listOpenForeshadows, listTimeline } from '../repos/consistency.repo.js';
import { listOpenConstraints } from '../repos/constraints.repo.js';
import { buildPovGuide } from './pov.js';
import { listScenes, searchKnowledge } from '../repos/layers.repo.js';
import { scenesToText } from './layers.js';

export interface BuiltContext {
  system: string;
  user: string;
  memoryUsed: MemoryUsage[];
}

const MODE_INSTRUCTION: Record<WriteMode, string> = {
  continue:
    '请顺着已有正文自然续写。视角与人称以**本章**的设定为准，语气与节奏与上文保持一致。不要重复已有内容，不要写总结或评论，直接输出续写正文。',
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
  /**
   * 默认预算 20000 字符（约 1.3 万 token）。
   * 原来 6000 太小：光是「硬约束 + 大纲」就能吃光，前情提要一条都进不来，
   * 而前情正是长篇不崩的关键。必选项的 cap 之和（16000）小于这个默认预算，
   * 所以即使全部写满，也天然给记忆留了 4000 字。
   */
  const budget = params.memoryBudget ?? 20_000;
  const memoryUsed: MemoryUsage[] = [];
  let remaining = budget;

  /**
   * 必选项（硬约束 / 大纲 / 细纲 / 场景 / 文风）的单块上限。
   * 没有上限时，作者写 5 万字硬约束会把模型上下文整个挤爆；
   * 截断比请求直接失败好，而且 memoryUsed 里能看到截掉了多少。
   */
  const REQUIRED_CAP = {
    rules: 6000,
    pov: 1200,
    constraints: 1500,
    outline: 4000,
    beats: 3000,
    scenes: 2000,
    style: 1000,
  } as const;

  /** 可裁剪的记忆块：装不下就不装，预算如实递减 */
  const take = (kind: MemoryUsage['kind'], label: string, text: string): string | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const cost = trimmed.length;
    if (cost > remaining) return null;
    remaining -= cost;
    memoryUsed.push({ kind, label, chars: cost });
    return trimmed;
  };

  /**
   * 必选项：一定注入，同样从预算里扣（可为 0，表示预算已经用尽）。
   * 预算用尽时不再硬塞——否则 5 万字硬约束会让整个请求超出模型上下文。
   * kind 用于前端的「上下文构成」分类，不要一律记成 style。
   */
  const required = (
    label: string,
    text: string,
    cap: number,
    kind: MemoryUsage['kind'],
  ): string | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const allowance = Math.min(cap, Math.max(0, remaining));
    if (allowance < 80) return null; // 剩这么点字不如不塞，免得截出半句话

    const suffix = '\n…（超出可注入额度，已截断）';
    let out = trimmed;
    if (trimmed.length > allowance) {
      out = `${trimmed.slice(0, Math.max(0, allowance - suffix.length))}${suffix}`;
    }
    remaining -= out.length;
    memoryUsed.push({ kind, label, chars: out.length });
    return out;
  };

  const blocks: string[] = [];

  // 0. 作者硬约束（考据规则 / 制度 / 禁令）——最高优先级
  const rulesBlock = required('作者硬约束', project.rules ?? '', REQUIRED_CAP.rules, 'rule');
  if (rulesBlock) {
    blocks.push(`## 作者硬约束（必须遵守，违反即算写错）\n${rulesBlock}`);
  }

  // 0.1 叙述视角守则：设定后是硬规则，优先级仅次于作者硬约束
  const povGuide = buildPovGuide(project, chapter);
  if (povGuide) {
    const povBlock = required('视角守则', povGuide, REQUIRED_CAP.pov, 'rule');
    if (povBlock) blocks.push(`## 叙述视角（硬性规则）\n${povBlock}`);
  }

  // 0.2 一致性检查沉淀下来的约束：上一轮错过的，本轮别再犯
  const openConstraints = listOpenConstraints(project.id, 6);
  if (openConstraints.length > 0) {
    const constraintsBlock = required(
      '写作约束',
      openConstraints.map((c) => `- ${c.text}`).join('\n'),
      REQUIRED_CAP.constraints,
      'rule',
    );
    if (constraintsBlock) {
      blocks.push(
        `## 此前检查发现的问题（本章必须避免重复，也不要与之矛盾）\n${constraintsBlock}`,
      );
    }
  }

  // 1. 本章任务：大纲 → 细纲 → 场景（必选项，最先占预算）
  const outlineBlock = required('本章大纲', chapter.outline, REQUIRED_CAP.outline, 'plan');
  if (outlineBlock) blocks.push(`## 本章大纲（必须遵守）\n${outlineBlock}`);

  const beatsBlock = required('本章细纲', chapter.beats ?? '', REQUIRED_CAP.beats, 'plan');
  if (beatsBlock) blocks.push(`## 本章细纲（按这些节拍写，不要跳跃）\n${beatsBlock}`);

  const scenes = listScenes(chapter.id);
  if (scenes.length > 0) {
    const scenesBlock = required(
      `${scenes.length} 个场景`,
      scenesToText(scenes),
      REQUIRED_CAP.scenes,
      'plan',
    );
    if (scenesBlock) blocks.push(`## 场景安排（按顺序推进）\n${scenesBlock}`);
  }

  // 2. 固定设定（人物/世界观等）
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

  // 3. 作者资料（引用溯源：明确标出来自哪份资料）
  //    放在前情摘要之前：写前事实清单查到的资料是「写错就成硬伤」的内容，
  //    不能因为前情太长被挤掉。优先用事实点的关键词检索，召回面比标题+大纲大得多。
  const factQueries = (chapter.facts ?? []).map((f) => f.query).filter(Boolean);
  const knowledgeQuery = factQueries.length
    ? factQueries.join(' ').slice(0, 600)
    : `${chapter.title} ${chapter.outline.slice(0, 200)}`;
  const hits = searchKnowledge(project.id, knowledgeQuery, 3);
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
        label: factQueries.length
          ? `${hits.length} 条资料引用（按事实清单检索）`
          : `${hits.length} 条资料引用`,
        chars: joined.length,
      });
    }
  }

  // 4. 未回收的伏笔（长篇一致性的核心：让模型知道哪些坑还没填）
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

  // 5. 关键时间点（防止时间线前后矛盾）
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
      memoryUsed.push({ kind: 'entity', label: `${lines.length} 条关键时间点`, chars: joined.length });
      blocks.push(`## 关键时间点（保持时间先后一致）\n${joined}`);
    }
  }

  // 6. 卷摘要
  if (chapter.volumeId) {
    const vol = listVolumes(project.id).find((v) => v.id === chapter.volumeId);
    const s = vol?.summary ? take('volume-summary', vol.title, vol.summary) : null;
    if (s) blocks.push(`## 本卷概要（${vol!.title}）\n${s}`);
  }

  // 7. 前情摘要（越近越重要，倒序取）
  const priors = listPriorSummaries(project.id, chapter.order, 30);
  if (priors.length > 0) {
    const picked: string[] = [];
    for (const p of priors) {
      const line = `- ${p.title}：${p.summary}`;
      // 放不下就跳过这一条，继续试更早（通常更短）的摘要；
      // 用 break 会在「最近一章摘要偏长」时把整段前情全部丢掉。
      if (line.length > remaining) continue;
      remaining -= line.length;
      picked.unshift(line);
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

  // 8. 文风（必选项）
  const style =
    required(
      '文风要求',
      project.styleGuide,
      REQUIRED_CAP.style,
      'style',
    ) || '自然流畅的中文小说叙述，克制而具体，避免辞藻堆砌。';
  blocks.push(`## 文风要求\n${style}`);

  const system = [
    `你是一位资深中文小说作家，正在为长篇小说《${project.title}》撰写正文。`,
    project.logline ? `作品简介：${project.logline}` : '',
    project.genre ? `题材类型：${project.genre}` : '',
    '',
    blocks.join('\n\n'),
    '',
    '## 硬性要求',
    '- 严格保持已有设定，不得擅自更改人物姓名、关系、能力与既定事实。',
    '- 不出现「作为AI」「以下是」之类的元叙述。',
    '- 直接输出小说正文，不要输出标题、序号或解释。',
    MODE_INSTRUCTION[mode],
  ]
    .filter((s) => s !== undefined)
    .join('\n');

  // 9. 用户消息：选区 / 已有正文 / 整章写作指令
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
