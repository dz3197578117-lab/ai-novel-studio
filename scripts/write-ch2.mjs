/** 用应用自己的写作链路生成《孤的肥皂》第 2 章正文并保存 */
const B = 'http://127.0.0.1:8787';
const api = async (m, p, b) => {
  const init = { method: m, headers: { 'Content-Type': 'application/json' } };
  if (m !== 'GET' && m !== 'HEAD') init.body = JSON.stringify(b ?? {});
  const r = await fetch(`${B}${p}`, init);
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
};

const projects = await api('GET', '/api/projects');
const p = projects.find((x) => x.title.includes('孤的肥皂'));
const chs = await api('GET', `/api/projects/${p.id}/chapters`);
const ch2 = chs[1];

console.log('生成中:', ch2.title);
const sw = Date.now();
const res = await fetch(`${B}/api/write/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: p.id, chapterId: ch2.id, mode: 'chapter' }),
  signal: AbortSignal.timeout(300_000),
});
if (!res.ok) {
  const t = await res.text();
  throw new Error(`write/stream ${res.status} ${t.slice(0, 400)}`);
}

const decoder = new TextDecoder();
let buf = '';
let text = '';
let memory = [];
let error = null;
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  const parts = buf.split('\n\n');
  buf = parts.pop() ?? '';
  for (const part of parts) {
    if (!part.startsWith('data: ')) continue;
    let ev;
    try { ev = JSON.parse(part.slice(6)); } catch { continue; }
    if (ev.type === 'delta') text += ev.text;
    else if (ev.type === 'meta') memory = ev.memoryUsed ?? [];
    else if (ev.type === 'error') error = ev.message;
  }
}
const secs = ((Date.now() - sw) / 1000).toFixed(1);
if (error) throw new Error(`生成失败：${error}`);
if (!text.trim()) throw new Error('生成结果为空');

console.log(`完成，耗时 ${secs}s，长度 ${text.length} 字`);
console.log('记忆注入:', memory.map((m) => `${m.label}(${m.chars})`).join(' + '));

// 质量自检
const me = (text.match(/我/g) ?? []).length;
const he = (text.match(/他/g) ?? []).length;
const dianxia = (text.match(/殿下/g) ?? []).length;
const wangye = (text.match(/王爷/g) ?? []).length;
console.log(`人称：我 ${me} / 他 ${he}｜禁用称谓：殿下 ${dianxia} / 王爷 ${wangye}`);

await api('PATCH', `/api/chapters/${ch2.id}`, { content: text, status: 'drafting' });
const saved = await api('GET', `/api/chapters/${ch2.id}`);
console.log(`已保存：${saved.wordCount} 字，状态 ${saved.status}`);

// 生成章节摘要（供后续章节做长期记忆）
try {
  const s = await api('POST', `/api/chapters/${ch2.id}/summarize`, {});
  console.log('摘要:', s.summary ?? s);
} catch (e) {
  console.log('摘要生成失败（不影响正文）:', e.message.slice(0, 120));
}

console.log('\n=== 开头 300 字 ===');
console.log(text.slice(0, 300));
console.log('\n=== 结尾 300 字 ===');
console.log(text.slice(-300));
