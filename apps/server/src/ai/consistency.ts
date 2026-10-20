import type {
  Chapter,
  ConsistencyIssue,
  ConsistencyReport,
  Entity,
  Foreshadow,
  Project,
  TimelineEvent,
} from '@novelforge/shared';
import { AiError } from './client.js';
import { repairTruncatedJson } from './draft.js';
import { buildPovCheckNote } from './pov.js';

/**
 * 允许的问题类型。提示词里的枚举示例必须和这里保持一致——
 * 之前新增 history / pov 时只改了 KINDS 没改示例，模型因此很少输出这两类。
 */
const ISSUE_KINDS = [
  'character',
  'timeline',
  'setting',
  'naming',
  'plot',
  'foreshadow',
  'history',
  'pov',
  'other',
] as const;

const TYPE_LABEL: Record<string, string> = {
  world: '世界观',
  character: '人物',
  faction: '势力',
  term: '名词',
  item: '物品',
  location: '地点',
};

/** 检查时最多带多少章的梗概 */
const MAX_CHAPTER_CONTEXT = 40;

export interface ConsistencyInput {
  project: Project;
  entities: Entity[];
  chapters: Chapter[];
  foreshadows: Foreshadow[];
  timeline: TimelineEvent[];
  /** 知识库资料（用标题做参考目录，让模型按作者提供的史实/资料校对） */
  knowledge?: { title: string; source: string; excerpt?: string }[];
}

export function buildConsistencyPrompt(input: ConsistencyInput): {
  system: string;
  user: string;
  scope: ConsistencyReport['scope'];
} {
  const { project, entities, chapters, foreshadows, timeline, knowledge = [] } = input;

  const rules = (project.rules ?? '').trim();
  const knowledgeText = knowledge.length
    ? knowledge
        .map((k) => `- ${k.title}${k.source ? `（${k.source}）` : ''}${k.excerpt ? `：${k.excerpt}` : ''}`)
        .join('\n')
    : '';

  const entityLines = entities
    .slice(0, 40)
    .map(
      (e) =>
        `- [${TYPE_LABEL[e.type] ?? e.type}] ${e.name}${
          e.aliases.length ? `（又称 ${e.aliases.join('、')}）` : ''
        }：${e.summary || e.body.slice(0, 100)}`,
    )
    .join('\n');

  const fsLines = foreshadows
    .map(
      (f) =>
        `- ${f.title}｜状态：${
          f.status === 'recovered' ? '已回收' : f.status === 'abandoned' ? '已放弃' : '未回收'
        }${f.detail ? `｜${f.detail}` : ''}`,
    )
    .join('\n');

  const tlLines = timeline
    .map((t) => `- ${t.storyTime || '（未标时间）'}｜${t.title}${t.detail ? `：${t.detail}` : ''}`)
    .join('\n');

  const chapterLines = chapters
    .slice(-MAX_CHAPTER_CONTEXT)
    .map((c, i) => {
      const idx = chapters.length - Math.min(MAX_CHAPTER_CONTEXT, chapters.length) + i;
      return `- 第${idx + 1}章 ${c.title}\n  大纲：${c.outline || '（无）'}\n  摘要：${
        c.summary || '（无）'
      }`;
    })
    .join('\n');

  // 只带最后一章正文，用来判断当下的写法是否与设定冲突
  const lastChapter = chapters[chapters.length - 1];
  const lastContent = lastChapter?.content?.trim()
    ? lastChapter.content.slice(-4000)
    : '';

  const system = `你是资深小说编辑，负责检查长篇连载的**设定一致性**。

你要找出真实存在的矛盾，不要泛泛而谈，也不要编造不存在的问题。
宁可少报，也不要报没有依据的。

检查维度：
1. character —— 人物性格、动机、能力是否与设定突变
2. timeline —— 时间线是否矛盾（先后顺序、季节、年龄）
3. setting —— 是否与世界观/设定条目冲突（吃书）
4. naming —— 人名、地名、称呼是否前后不一致
5. plot —— 情节是否有逻辑硬伤（因果不成立、动机不足、能力越界）
6. foreshadow —— 伏笔是否有埋无收、或回收方式与铺垫矛盾
7. history —— 是否符合作者硬约束、史实、制度与常识（官制、称谓、礼仪、器物、银钱数目、办事流程）
8. pov —— 人称与视角是否前后一致，具体查四类：
   a) 第一人称正文 vs 第三人称大纲/细纲/场景卡（材料与正文人称不一致）
   b) 同一段叙述里人称跳变（前句「我」，后句用第三人称称呼自己）
   c) **叙述者用自己的名字指代自己**（如「我攥紧拳头。林砚知道……」）——这是典型视角越界，
      但注意排除三种合法情形：名字出现在**台词**里、**他人视角**的转述、作者刻意写的
      **回忆/自我抽离**（此时应为整段统一，不是一句一换）
   d) 写进主角当前感知不到的信息（别人的心理、主角不在场的场景）

对 pov 维度：严格按「叙述视角设定」里的默认视角与判定标准执行。
**长篇不可能一种视角写到底**——符合作者声明规则、且有分节标记的切换，属正常写法，不要报错。
只在以下情况报：同一场景内跳进非视角人物内心（high）、写视角人物感知不到的信息（high）、
未声明或缺标记的切换（medium）、正文与大纲人称不一致（medium）。

对 history 维度要特别严格：
- 如果作者写了「硬约束」，任何与之冲突的情节都算 high
- 如果故事有明确历史背景，制度性错误（例如「朝廷向皇子收冬衣钱」「皇子亮腰牌就能压住京兆府」）算 high
- 拿不准是否史实时，用 severity=low 并在 detail 里说明「需作者确认」，不要武断

只输出一个 JSON 对象，不要解释，不要 markdown 代码块：
{
  "issues": [
    {
      "kind": "${ISSUE_KINDS.join('|')}",
      "severity": "low|medium|high",
      "title": "一句话说清问题",
      "detail": "哪里矛盾：具体引用了什么设定、哪一章的什么描写",
      "suggestion": "可执行的修改建议",
      "refs": ["相关章节标题或设定名"]
    }
  ]
}

如果没有发现问题，输出 {"issues": []}。最多列 8 条，按严重程度排序。`;

  const user = `## 作品
书名：${project.title}
简介：${project.logline || '（无）'}
题材：${project.genre || '（无）'}
文风要求：${project.styleGuide || '（无）'}
${rules ? `\n## 作者硬约束（最高优先级，违反即算错误）\n${rules}` : ''}

## 叙述视角设定
${buildPovCheckNote(project)}
${knowledgeText ? `\n## 作者提供的参考资料（可据此校对史实/制度）\n${knowledgeText}` : ''}

## 设定条目（共 ${entities.length} 条，节选前 40 条）
${entityLines || '（暂无）'}

## 伏笔台账（共 ${foreshadows.length} 条）
${fsLines || '（暂无）'}

## 时间线（共 ${timeline.length} 条）
${tlLines || '（暂无）'}

## 章节梗概（最近 ${Math.min(chapters.length, MAX_CHAPTER_CONTEXT)} 章，共 ${
    chapters.length
  } 章）
${chapterLines || '（暂无）'}
${lastContent ? `\n## 最后一章正文（结尾部分，用于判断当下写法）\n${lastContent}` : ''}

请检查上面这些材料之间是否存在矛盾。`;

  return {
    system,
    user,
    scope: {
      chapters: chapters.length,
      entities: entities.length,
      foreshadows: foreshadows.length,
      timeline: timeline.length,
    },
  };
}

const KINDS = new Set<string>(ISSUE_KINDS);
const SEVERITIES = new Set(['low', 'medium', 'high']);

/** 解析检查结果，容忍代码块与被截断的输出 */
export function parseConsistencyReport(
  raw: string,
  scope: ConsistencyReport['scope'],
): ConsistencyReport {
  const text = String(raw ?? '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = text.indexOf('{');
  if (start < 0) {
    throw new AiError('模型没有返回可解析的检查结果，请重试。');
  }
  const end = text.lastIndexOf('}');
  const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);

  let json: unknown = null;
  try {
    json = JSON.parse(candidate);
  } catch {
    json = repairTruncatedJson(raw);
  }
  if (!json || typeof json !== 'object') {
    throw new AiError('模型返回的检查结果格式有误，请重试。');
  }

  const o = json as Record<string, unknown>;
  const issuesRaw = Array.isArray(o.issues) ? o.issues : [];

  const issues: ConsistencyIssue[] = issuesRaw
    .slice(0, 20)
    .map((it) => {
      const r = it as Record<string, unknown>;
      const kind = String(r.kind ?? 'other');
      const severity = String(r.severity ?? 'medium');
      return {
        kind: (KINDS.has(kind) ? kind : 'other') as ConsistencyIssue['kind'],
        severity: (SEVERITIES.has(severity) ? severity : 'medium') as ConsistencyIssue['severity'],
        title: String(r.title ?? '').slice(0, 200) || '（未命名问题）',
        detail: String(r.detail ?? '').slice(0, 2000),
        suggestion: String(r.suggestion ?? '').slice(0, 2000),
        refs: Array.isArray(r.refs)
          ? r.refs.filter((x): x is string => typeof x === 'string').slice(0, 8)
          : [],
      };
    })
    // 严重程度高的排前面
    .sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 } as const;
      return rank[a.severity] - rank[b.severity];
    });

  return { issues, scope, createdAt: new Date().toISOString() };
}
