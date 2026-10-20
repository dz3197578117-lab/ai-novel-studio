import type {
  Chapter,
  Entity,
  FactPoint,
  FactSheet,
  Project,
  SelfFixResult,
} from '@novelforge/shared';
import { repairTruncatedJson } from './draft.js';

/** 从模型输出里取出第一个 JSON 对象，容忍代码块与前后废话 */
function extractJson(raw: string): unknown {
  const text = String(raw ?? '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  const end = text.lastIndexOf('}');
  const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    return repairTruncatedJson(text.slice(start));
  }
}

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

/**
 * 自查整改：让模型拿着「核查点 + 检索到的资料」直接改写本章大纲/细纲。
 *
 * 为什么不让作者自己改：资料检索命中后，改法仍是写作决策，
 * 模型能一次改完并附上依据；作者只需判断采纳与否。
 */
export function buildSelfFixPrompt(input: {
  project: Project;
  chapter: Chapter;
  entities: Entity[];
  points: FactPoint[];
  hits: FactSheet['hits'];
}): { system: string; user: string } {
  const { project, chapter, entities, points, hits } = input;
  const rules = (project.rules ?? '').trim();

  const system = `你是长篇小说的资料员兼责任编辑，负责在动笔前把本章大纲/细纲改成「不与资料和设定冲突」的版本。

工作方式：
1. 逐个看「核查点」，再对照「检索到的资料」判断原文写法是否站得住。
2. 站得住的不要动；站不住的按资料改写，改动最小化——只修冲突处，不要重写文风、不要改剧情走向。
3. 资料没覆盖到的点，不要编造史实，保留原写法并在 changes 里标 unknown，说明「资料未覆盖，按硬约束推断」。
4. 保持原文的叙述人称与称谓（例如第一人称就还是第一人称、太监称「阿哥」不称「殿下」）。
5. 不要新增原文没有的人物、势力、地点。

只输出一个 JSON 对象，不要解释，不要 markdown 代码块：
{
  "outline": "修订后的大纲（原文已没问题就原样返回）",
  "beats": "修订后的细纲（原文没有细纲则返回空字符串；原文有则按原格式修）",
  "changes": [
    {"point": "对应哪个核查点", "verdict": "ok|fixed|unknown", "action": "改了什么/为什么不用改", "source": "引用的资料名（可空）"}
  ]
}

verdict 取值：ok=原文就符合；fixed=已按资料改正；unknown=资料未覆盖。
changes 最多 5 条，每条 action 不超过 40 字；大纲控制在 150 字内、细纲不超过 6 行。`;

  const entityLines = entities
    .slice(0, 6)
    .map((e) => `- ${e.name}：${(e.summary || e.body).slice(0, 36)}`)
    .join('\n');

  const pointLines = points
    .map((p, i) => `${i + 1}. ${p.mustHave ? '【必查】' : ''}${p.point}`)
    .join('\n');

  // 控制请求体积：服务商按每分钟 token 限流，资料只带最相关的几段短摘录
  const hitLines = hits.length
    ? hits
        .slice(0, 3)
        .map((h) => `- 〔${h.docTitle}〕${h.text.slice(0, 140)}`)
        .join('\n')
    : '（没有检索到资料）';

  const user = `## 作品
书名：${project.title}｜题材：${project.genre || '未填'}
${rules ? `\n## 作者硬约束（最高优先级）\n${rules.slice(0, 700)}` : ''}

## 核心设定
${entityLines || '（暂无）'}

## 本章原文
标题：${chapter.title}
大纲：${chapter.outline || '（无）'}
细纲：${(chapter.beats || '（无）').slice(0, 600)}

## 需要核查的点
${pointLines}

## 检索到的作者资料
${hitLines}

## 输出要求
按 JSON 输出修订后的大纲、细纲与改动依据。`;

  return { system, user };
}

/** 解析自查整改结果，容忍代码块、缺字段与截断 */
export function parseSelfFix(raw: string): SelfFixResult {
  const json = extractJson(raw);
  if (json && typeof json === 'object') {
    const parsed = fromJsonObject(json as Record<string, unknown>);
    if (parsed) return parsed;
  }
  // JSON 被截断（推理模型吃满输出预算时很常见）：按字段正则抢救
  const salvaged = salvageTruncated(raw);
  if (salvaged) return salvaged;
  throw new Error('模型没有返回可解析的整改结果');
}

function fromJsonObject(o: Record<string, unknown>): SelfFixResult | null {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const outline = str(o.outline);
  const beats = str(o.beats);
  if (!outline && !beats) return null;

  const rawChanges = Array.isArray(o.changes) ? o.changes : [];
  const changes: SelfFixResult['changes'] = [];
  for (const item of rawChanges) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const point = str(r.point);
    if (!point) continue;
    const verdictRaw = str(r.verdict);
    const verdict: SelfFixResult['changes'][number]['verdict'] =
      verdictRaw === 'fixed' || verdictRaw === 'unknown' ? verdictRaw : 'ok';
    changes.push({
      point: point.slice(0, 200),
      verdict,
      action: str(r.action).slice(0, 600),
      source: str(r.source).slice(0, 200) || undefined,
    });
    if (changes.length >= 8) break;
  }

  return {
    outline,
    beats,
    changes,
    hitCount: 0,
    generatedAt: new Date().toISOString(),
  };
}

function unescapeJsonString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * 从被截断的 JSON 文本里抢救字段。
 * 模型经常在写完 outline 后就被 budget 截断，此时整段 JSON 非法，
 * 但 outline 字段本身是完整的——直接按 "field": "..." 正则取。
 */
function salvageTruncated(raw: string): SelfFixResult | null {
  const text = String(raw ?? '');
  const field = (name: string): string => {
    const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
    return m ? unescapeJsonString(m[1]!) : '';
  };
  const outline = field('outline');
  const beats = field('beats');
  if (!outline && !beats) return null;

  const changes: SelfFixResult['changes'] = [];
  const itemRe =
    /\{[^{}]*"point"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?"verdict"\s*:\s*"(\w+)"[^{}]*?"action"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(text)) && changes.length < 8) {
    const verdictRaw = m[2]!;
    changes.push({
      point: unescapeJsonString(m[1]!).slice(0, 200),
      verdict: verdictRaw === 'fixed' || verdictRaw === 'unknown' ? verdictRaw : 'ok',
      action: unescapeJsonString(m[3]!).slice(0, 600),
    });
  }

  return {
    outline,
    beats,
    changes,
    hitCount: 0,
    generatedAt: new Date().toISOString(),
  };
}
