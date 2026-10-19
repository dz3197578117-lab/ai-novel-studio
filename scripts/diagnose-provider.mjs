/**
 * 诊断「生成方案」失败：用当前生效配置直接请求一次，打印原始返回特征。
 * 不打印 API Key。
 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('apps/server/data/novelforge.db');
const get = (k) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return row ? JSON.parse(row.value) : null;
};
const profiles = get('profiles') ?? [];
const activeId = get('activeProfileId');
const active = profiles.find((p) => p.id === activeId) ?? profiles[0];
db.close();

if (!active) {
  console.error('没有配置');
  process.exit(1);
}

console.log('provider:', active.name, '| baseUrl:', active.baseUrl, '| model:', active.model);
console.log('temperature:', active.temperature, '| maxTokens:', active.maxTokens);

const system = `你是资深网络小说策划，擅长把一句话点子扩成可执行的创作方案。

只输出一个 JSON 对象，不要解释，不要 markdown 代码块，不要多余文字。

JSON 结构：
{
  "title": "书名，4-12 字",
  "logline": "一句话简介",
  "genre": "题材",
  "styleGuide": "文风要求",
  "entities": [{ "type": "character", "name": "名称", "aliases": [], "summary": "一句话", "fields": [{ "key": "年龄", "value": "17" }], "body": "详细设定", "pinned": true }],
  "volumes": [{ "title": "第一卷", "summary": "本卷概要" }],
  "chapters": [{ "volumeIndex": 0, "title": "第一章", "outline": "本章梗概" }]
}`;

const user = '我的需求：都市异能爽文，主角绑定攻略系统\n目标章数：6 章';

const body = {
  model: active.model,
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ],
  stream: false,
  temperature: active.temperature ?? 0.8,
  max_tokens: active.maxTokens || undefined,
};

console.log('\n--- 请求 ---');
console.log('max_tokens =', body.max_tokens, '| 期望 6 章');

const res = await fetch(`${active.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${active.apiKey}`,
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(180000),
});

console.log('HTTP', res.status);
if (!res.ok) {
  const t = await res.text();
  console.log('错误正文:', t.slice(0, 800));
  process.exit(0);
}

const json = await res.json();
const choice = json.choices?.[0];
const content = choice?.message?.content ?? '';
console.log('\n--- 返回特征 ---');
console.log('finish_reason:', choice?.finish_reason);
console.log('usage:', JSON.stringify(json.usage));
console.log('content 长度:', content.length);
console.log('\n--- 前 300 字 ---');
console.log(content.slice(0, 300));
console.log('\n--- 后 300 字 ---');
console.log(content.slice(-300));

// 试着按应用的逻辑解析
const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim();
const start = cleaned.indexOf('{');
const end = cleaned.lastIndexOf('}');
const candidate = start >= 0 ? (end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start)) : '';
try {
  const parsed = JSON.parse(candidate);
  console.log('\n[解析] 成功，chapters =', parsed.chapters?.length);
} catch (e) {
  console.log('\n[解析] 失败:', e.message);
  console.log('候选串长度:', candidate.length, '| 以何结尾:', JSON.stringify(candidate.slice(-60)));
}
