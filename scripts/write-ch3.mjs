/** 生成《孤的肥皂》第 3 章：改大纲 → 出细纲 → 写正文 → 存摘要 */
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
const ch3 = chs[2];

const outline =
  '我不敢以皇子的脸面亲自出摊，让小太监福顺在东市角落铺张油纸摆皂，自己在对面茶棚看着。邻摊笑这是"泥疙瘩"，一富户婆子试用后当场买走三块。地头蛇晃过来要收摊钱，我才出面谈，几句话把抽成压到一成。婆子临走回头，说我家夫人想见你——市井与内宅两条线同时开了口。';
await api('PATCH', `/api/chapters/${ch3.id}`, { outline, status: 'drafting' });
console.log('✓ 第3章大纲已改第一人称');

console.log('生成细纲…');
const beats = await api('POST', '/api/ai/chapter-beats', { projectId: p.id, chapterId: ch3.id });
console.log(beats.beats.slice(0, 600));
console.log(`\n人称：我 ${(beats.beats.match(/我/g) ?? []).length} / 他 ${(beats.beats.match(/他/g) ?? []).length}`);

console.log('\n生成正文…');
const sw = Date.now();
const res = await fetch(`${B}/api/write/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: p.id, chapterId: ch3.id, mode: 'chapter' }),
  signal: AbortSignal.timeout(300_000),
});
if (!res.ok) throw new Error(`write/stream ${res.status} ${(await res.text()).slice(0, 300)}`);

const decoder = new TextDecoder();
let buf = '';
let text = '';
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
    else if (ev.type === 'error') error = ev.message;
  }
}
if (error) throw new Error(`生成失败：${error}`);
if (!text.trim()) throw new Error('生成结果为空');
console.log(`完成 ${((Date.now() - sw) / 1000).toFixed(1)}s，${text.length} 字`);

await api('PATCH', `/api/chapters/${ch3.id}`, { content: text, status: 'drafting' });
const saved = await api('GET', `/api/chapters/${ch3.id}`);
console.log(`已保存 ${saved.wordCount} 字`);
const t = saved.content;
console.log(`人称：我 ${(t.match(/我/g) ?? []).length} / 他 ${(t.match(/他/g) ?? []).length}｜殿下 ${(t.match(/殿下/g) ?? []).length}｜王爷 ${(t.match(/王爷/g) ?? []).length}`);

try {
  const s = await api('POST', `/api/chapters/${ch3.id}/summarize`, {});
  console.log('摘要:', (s.summary ?? JSON.stringify(s)).slice(0, 160));
} catch (e) {
  console.log('摘要失败:', e.message.slice(0, 100));
}

console.log('\n=== 开头 260 字 ===');
console.log(text.slice(0, 260));
console.log('\n=== 结尾 260 字 ===');
console.log(text.slice(-260));
