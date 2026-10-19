import type { InterviewMessage, InterviewReply } from '@novelforge/shared';
import { AiError } from './client.js';

/** 访谈最多问几轮，避免没完没了 */
const MAX_TURNS = 4;

/**
 * 构造「对话式访谈」的提示词。
 * 目标：通过简短追问补齐 4 项信息，然后输出一份可直接用于生成方案的需求（brief）。
 */
export function buildInterviewPrompt(messages: InterviewMessage[]): {
  system: string;
  user: string;
} {
  const askedCount = messages.filter((m) => m.role === 'assistant').length;

  const system = `你是小说策划助手，正在和用户聊天，帮他把「想写一部小说」这个模糊念头聊成可执行的需求。

需要通过追问弄清四件事：
1. 题材类型（玄幻/都市/悬疑/科幻/言情/历史…）
2. 主角与核心设定（是谁、想要什么、阻力是什么）
3. 基调与文风（热血爽文 / 冷峻克制 / 轻松诙谐 …）
4. 篇幅预期（短篇几万字 / 长篇连载）

规则：
- 一次只问一个问题，不要列一堆问题轰炸用户。
- 已经问过 ${askedCount} 轮，上限 ${MAX_TURNS} 轮。到上限或信息够了就不要再问。
- 用户回答简短也没关系，你可以替他做决定，但要在 say 里说明你的判断。
- 不要替用户写正文，只做需求澄清。
- 语气自然、口语化，像一个有经验的编辑。

只输出一个 JSON 对象，不要解释，不要 markdown 代码块：
{
  "say": "给用户看的一句话（提问或确认）",
  "options": ["可直接点选的短选项，0-4 个，没有就空数组"],
  "done": false,
  "brief": ""
}

当 done 为 true 时：
- say 写一句简短总结（例如「明白了，我按这个方向出一版方案」）
- brief 写 150-300 字的中文需求描述，必须包含：题材、主角与核心冲突、基调文风、篇幅预期。
  brief 会直接交给下游生成书名/设定/卷章大纲，所以要具体、可执行。`;

  const history = messages
    .map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.content}`)
    .join('\n');

  const user = `对话记录：\n${history || '（还没有开始，用户刚说想写一部小说）'}\n\n现在请给出你的下一条回应（JSON）。`;

  return { system, user };
}

/** 解析访谈响应，容忍代码块与多余解释 */
export function parseInterviewResponse(raw: string): InterviewReply {
  const text = String(raw ?? '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = text.indexOf('{');
  if (start < 0) {
    throw new AiError('模型没有返回可解析的对话内容，请重试。');
  }
  const end = text.lastIndexOf('}');
  const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    throw new AiError('模型返回的内容格式有误，请重试。');
  }
  if (!json || typeof json !== 'object') {
    throw new AiError('模型返回的结构不正确，请重试。');
  }

  const o = json as Record<string, unknown>;
  const say = typeof o.say === 'string' ? o.say.trim() : '';
  const options = Array.isArray(o.options)
    ? o.options
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, 4)
    : [];
  const done = o.done === true;
  const brief = typeof o.brief === 'string' ? o.brief.trim() : '';

  if (!say && !brief) {
    throw new AiError('模型没有给出有效回应，请重试。');
  }

  return {
    say: say || '明白了，我来出方案。',
    options,
    // done 为真但没给 brief 时，不能直接生成，退化为继续对话
    done: done && brief.length > 0,
    brief,
  };
}
