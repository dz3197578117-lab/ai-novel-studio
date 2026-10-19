import type { Chapter, Project } from '@novelforge/shared';

export type PlanField = 'outline' | 'beats';

/**
 * 作者的「提问 / 整改」指令面板。
 * ask：只回答，不改文本；revise：按指令重写大纲或细纲。
 */
export function buildPlanRevisePrompt(params: {
  mode: 'ask' | 'revise';
  field: PlanField;
  project: Project;
  chapter: Chapter;
  prev?: Chapter | null;
  next?: Chapter | null;
  openForeshadows: string[];
  instruction: string;
}): { system: string; user: string } {
  const { mode, field, project, chapter, prev, next, openForeshadows, instruction } = params;
  const fieldName = field === 'outline' ? '本章大纲' : '本章细纲（节拍）';
  const current = (field === 'outline' ? chapter.outline : chapter.beats ?? '').trim();

  const context = [
    `## 作品`,
    `书名：${project.title}`,
    project.genre ? `题材：${project.genre}` : '',
    project.logline ? `简介：${project.logline}` : '',
    project.styleGuide ? `文风：${project.styleGuide}` : '',
    '',
    `## 当前章节`,
    `标题：${chapter.title}`,
    `本章大纲：${chapter.outline.trim() || '（空）'}`,
    `本章细纲：${(chapter.beats ?? '').trim() || '（空）'}`,
    '',
    prev ? `## 上一章（承接，不要冲突）\n${prev.title}：${prev.outline || '（无大纲）'}` : '',
    next ? `## 下一章（为它留好落点）\n${next.title}：${next.outline || '（无大纲）'}` : '',
    openForeshadows.length
      ? `## 尚未回收的伏笔（可呼应，但别提前揭晓）\n${openForeshadows.map((f) => `- ${f}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  if (mode === 'ask') {
    const system = `你是资深小说编辑，正在和作者讨论一本书的章节规划。

要求：
- 直接回答作者的问题，别绕弯子
- 指出具体问题时要引用章节里的具体内容，不要泛泛而谈
- 给出可执行的改法（改成什么、为什么）
- 用中文短段落回答，不要用 markdown 标题，控制在 300 字以内

当前讨论对象：${fieldName}`;
    return { system, user: `${context}\n\n## 作者的问题\n${instruction}` };
  }

  const system = `你是资深小说编辑，负责按作者要求修改${fieldName}。

硬性规则：
- 只输出修改后的${fieldName}正文，不要任何解释、前言、markdown 代码块
- 保留作者原有的设定与已发生的情节，不要凭空改设定
- 必须与上一章衔接、为下一章留落点
${
  field === 'outline'
    ? '- 格式：一段 60-120 字的大纲，说清谁做了什么、冲突、结果、钩子'
    : '- 格式：5-8 条节拍，每条一行，格式 `1. 【场景/动作】… → 造成什么变化`，最后一条是钩子'
}`;

  return {
    system,
    user: `${context}\n\n## 作者的要求\n${instruction}\n\n请输出修改后的${fieldName}。`,
  };
}

/** 清理模型输出（去掉常见的前后缀与代码块） */
export function cleanPlanOutput(raw: string, field: PlanField): string {
  let text = String(raw ?? '')
    .replace(/```[a-z]*/gi, '')
    .replace(/```/g, '')
    .trim();

  // 去掉「修改后的大纲：」这类前缀
  text = text.replace(
    new RegExp(`^(修改后|整改后|新的|以下是)?的?${field === 'outline' ? '大纲' : '细纲'}[:：]\\s*`),
    '',
  );
  return text.trim();
}
