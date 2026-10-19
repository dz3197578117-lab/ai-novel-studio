import type { Chapter, Project, Scene, SceneInput } from '@novelforge/shared';
import { AiError } from './client.js';
import { repairTruncatedJson } from './draft.js';

/** 大纲 → 细纲 */
export function buildBeatsPrompt(
  project: Project,
  chapter: Chapter,
  priorSummaries: string[],
  settingBrief?: string,
): { system: string; user: string } {
  const system = `你是小说结构编辑，负责把「章节大纲」拆成可执行的「细纲」（beat sheet）。

细纲要求：
- 按顺序列出 5-8 个节拍，每个节拍一行，格式：\`1. 【场景/动作】具体发生了什么 → 造成什么变化\`
- 每个节拍都要有**具体动作或对话**，不要写「展现人物性格」这种抽象描述
- 最后一个节拍必须是一个钩子（悬念/转折/新问题）
- **人称必须与正文一致**：如果作品用第一人称（主角称「我」），细纲也用「我」写，不要写成「他」
- 只输出细纲正文，不要解释，不要标题

作品：《${project.title}》
文风：${project.styleGuide || '自然流畅'}
${priorSummaries.length ? `前情：${priorSummaries.join('；')}` : ''}
${settingBrief ? `\n${settingBrief}` : ''}`;

  const user = `本章：${chapter.title}
本章大纲：${chapter.outline || '（作者还没写大纲，请根据书名和上文合理设计）'}
${chapter.beats ? `已有细纲（可优化）：\n${chapter.beats}` : ''}
${chapter.content.trim() ? `已写正文开头（人称/称谓以此为准）：\n${chapter.content.slice(0, 300)}` : ''}

请输出细纲。`;

  return { system, user };
}

/** 细纲 → 场景卡 */
export function buildScenesPrompt(
  project: Project,
  chapter: Chapter,
  settingBrief?: string,
): { system: string; user: string } {
  const system = `你是小说场景设计师。把一章拆成 3-6 个**场景卡**，每张卡是连续时空中的一段戏。

只输出一个 JSON 对象，不要解释，不要 markdown 代码块：
{
  "scenes": [
    {
      "title": "场景标题（4-10 字）",
      "pov": "视角人物",
      "location": "地点",
      "goal": "这一场谁想要什么",
      "conflict": "阻力是什么",
      "outcome": "结果，以及留给下一场的钩子",
      "keyLines": "这一场最想写的 1-2 句关键台词"
    }
  ]
}

要求：
- 场景之间必须有因果推进，不能各自独立
- 每个场景都要有「目标-阻力-结果」三要素
- 不要写成大纲复述，要具体到「在哪、和谁、争什么」
- **pov 必须与正文的叙述视角一致**：第一人称作品里 pov 写「我」；且只写主角经历过的场景，
  不要凭空加主角不在场的场景
- **台词里的人称要符合作者设定**（例如太监称皇子「阿哥」而不是「殿下」）

作品：《${project.title}》｜题材：${project.genre || '未定'}
${settingBrief ? `\n${settingBrief}` : ''}`;

  const user = `本章：${chapter.title}
本章大纲：${chapter.outline || '（无）'}
细纲：${chapter.beats || '（无，请按大纲合理拆分）'}
${chapter.content.trim() ? `已写正文开头（人称/称谓以此为准）：\n${chapter.content.slice(0, 300)}` : ''}

请输出场景卡。`;

  return { system, user };
}

/** 解析场景卡；容忍代码块与截断 */
export function parseSceneCards(raw: string): SceneInput[] {
  const text = String(raw ?? '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = text.indexOf('{');
  if (start < 0) throw new AiError('模型没有返回可解析的场景卡，请重试。');
  const end = text.lastIndexOf('}');
  const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);

  let json: unknown = null;
  try {
    json = JSON.parse(candidate);
  } catch {
    json = repairTruncatedJson(raw);
  }
  if (!json || typeof json !== 'object') {
    throw new AiError('场景卡格式有误，请重试。');
  }

  const arr = (json as Record<string, unknown>).scenes;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new AiError('模型没有给出场景卡，请重试。');
  }

  return arr.slice(0, 8).map((s) => {
    const r = s as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    return {
      title: str(r.title).slice(0, 60) || '未命名场景',
      pov: str(r.pov).slice(0, 60),
      location: str(r.location).slice(0, 60),
      goal: str(r.goal).slice(0, 300),
      conflict: str(r.conflict).slice(0, 300),
      outcome: str(r.outcome).slice(0, 300),
      keyLines: str(r.keyLines).slice(0, 500),
    };
  });
}

/** 把场景卡拼成提示词里的一段（写作时用） */
export function scenesToText(scenes: Scene[]): string {
  return scenes
    .map(
      (s, i) =>
        `${i + 1}. ${s.title}${
          s.pov ? `（视角：${s.pov}）` : ''
        }${s.location ? ` @${s.location}` : ''}\n   目标：${s.goal || '—'}\n   阻力：${
          s.conflict || '—'
        }\n   结果：${s.outcome || '—'}${s.keyLines ? `\n   关键台词：${s.keyLines}` : ''}`,
    )
    .join('\n');
}
