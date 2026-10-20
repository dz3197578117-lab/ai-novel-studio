import type { Chapter, Entity, FactPoint, Project } from '@novelforge/shared';
import { repairTruncatedJson } from './draft.js';

/**
 * 写作前的事实核查：先让模型说清「这一章写错就会成硬伤的点」，
 * 再拿这些点去检索作者资料。
 *
 * 为什么需要这一步：上下文里的知识库检索原本只用「章节标题 + 大纲前 200 字」
 * 做关键词匹配，大纲里没写到的词就召回不到。让模型先展开成具体的核查项，
 * 检索的召回面会大很多。
 */
export function buildFactPrompt(input: {
  project: Project;
  chapter: Chapter;
  entities: Entity[];
  docs: { title: string; source: string }[];
}): { system: string; user: string } {
  const { project, chapter, entities, docs } = input;

  const system = `你是长篇小说的资料员，负责在作者动笔前把「写错就会成硬伤」的事实点列清楚。

先判断作品的类型：
- 真实历史 / 历史向：重点核查朝代年号、官职品级与机构、称谓礼节、器物形制、地理方位与路程、银钱物价、专业流程（科举、诉讼、军制、医术）。
- 架空 / 玄幻 / 科幻：不要求史实准确，重点核查本书自身的规则边界——力量体系、势力关系、地理格局、器物功能、称谓习惯。

只列事实核查项。不要评价剧情，不要提写作建议，不要复述大纲，不要编造资料里没有的细节。
宁少勿滥：与本章情节无关的不要列。3-8 条即可。
如果作者已有资料能回答，也要列出来（写作时会引用那段资料）。`;

  const rules = (project.rules ?? '').trim();
  const entityLines = entities
    .slice(0, 20)
    .map((e) => `- ${e.name}：${e.summary || e.body.slice(0, 60)}`)
    .join('\n');

  const docLines = docs.length
    ? docs.map((d) => `- ${d.title}${d.source ? `（${d.source}）` : ''}`).join('\n')
    : '（暂无上传资料）';

  const user = `## 作品
书名：${project.title}
题材：${project.genre || '（未填）'}
简介：${project.logline || '（未填）'}
${rules ? `\n## 作者硬约束\n${rules}` : ''}

## 核心设定
${entityLines || '（暂无）'}

## 作者已上传的资料（只有标题，供你判断哪些能查）
${docLines}

## 本章
标题：${chapter.title}
大纲：${chapter.outline || '（无）'}
${chapter.beats ? `细纲：${chapter.beats}` : ''}

## 输出要求
只输出一个 JSON 对象，不要解释，不要 markdown 代码块：
{"points":[{"point":"要核实什么（一句话）","query":"检索关键词 2-4 个","mustHave":true}]}

mustHave 表示「写错就是硬伤」，一般 1-3 条是 true，其余为 false。`;

  return { system, user };
}

/** 解析模型输出，容忍代码块、前后废话与截断 */
export function parseFactPoints(raw: string): FactPoint[] {
  const text = String(raw ?? '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = text.indexOf('{');
  let json: unknown = null;
  if (start >= 0) {
    const end = text.lastIndexOf('}');
    const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);
    try {
      json = JSON.parse(candidate);
    } catch {
      json = repairTruncatedJson(text.slice(start));
    }
  }
  if (!json || typeof json !== 'object') return [];

  const rawPoints = (json as { points?: unknown }).points;
  if (!Array.isArray(rawPoints)) return [];

  const out: FactPoint[] = [];
  for (const item of rawPoints) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const point = String(r.point ?? '').trim();
    if (!point) continue;
    const query = String(r.query ?? '').trim() || point;
    out.push({
      point: point.slice(0, 120),
      query: query.slice(0, 120),
      mustHave: Boolean(r.mustHave),
    });
    if (out.length >= 10) break;
  }
  return out;
}
