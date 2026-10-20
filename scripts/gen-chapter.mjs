/**
 * 生成/重写某一章，验证「3000-6000 字」目标与自动续写。
 * 用法: node scripts/gen-chapter.mjs <章序号从1开始> [chapter|chapter-rewrite] [新大纲]
 */
const B = 'http://127.0.0.1:8787';
const idx = Number(process.argv[2] ?? 2) - 1;
const mode = process.argv[3] ?? 'chapter';
const newOutline = process.argv[4];

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
const target = chs[idx];

if (newOutline) {
  await api('PATCH', `/api/chapters/${target.id}`, { outline: newOutline });
  console.log('已更新大纲');
}
const before = await api('GET', `/api/chapters/${target.id}`);
console.log(`目标：${before.title} | 现有 ${before.wordCount} 字 | 模式 ${mode}`);
console.log(`大纲：${(before.outline || '（无）').slice(0, 100)}`);

const sw = Date.now();
const res = await fetch(`${B}/api/write/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: p.id, chapterId: target.id, mode }),
  signal: AbortSignal.timeout(900_000),
});
if (!res.ok) throw new Error(`write/stream ${res.status} ${(await res.text()).slice(0, 300)}`);

const decoder = new TextDecoder();
let buf = '';
let text = '';
let error = null;
let rounds = 0;
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  const parts = buf.split('\n\n');
  buf = parts.pop() ?? '';
  for (const part of parts) {
    if (!part.startsWith('data: ')) continue;
    let ev;
    try { ev = JSON.parse(part.slice(6)); } catch { continue; }
    if (ev.type === 'delta') text += ev.text;
    else if (ev.type === 'meta') rounds++;
    else if (ev.type === 'error') error = ev.message;
  }
}
if (error) throw new Error(`生成失败：${error}`);
if (!text.trim()) throw new Error('生成结果为空');

const secs = ((Date.now() - sw) / 1000).toFixed(1);
const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
console.log(`完成 ${secs}s | 字符 ${text.length} | 汉字 ${cjk} | 段(meta) ${rounds}`);
console.log(`人称：我 ${(text.match(/我/g) ?? []).length} / 他 ${(text.match(/他/g) ?? []).length} | 殿下 ${(text.match(/殿下/g) ?? []).length} | 王爷 ${(text.match(/王爷/g) ?? []).length}`);
console.log(`标题残留: ${/^\s*#{0,6}\s*第[一二三四五六七八九十百千\d]+章/.test(text) ? '有 ⚠' : '无 ✓'}`);

await api('PATCH', `/api/chapters/${target.id}`, { content: text, status: 'drafting' });
const saved = await api('GET', `/api/chapters/${target.id}`);
console.log(`已保存 ${saved.wordCount} 字（目标 3000-6000：${saved.wordCount >= 3000 ? '达标 ✓' : '未达标 ⚠'}）`);

try {
  await api('POST', `/api/chapters/${target.id}/summarize`, {});
  console.log('摘要已更新');
} catch (e) {
  console.log('摘要失败:', e.message.slice(0, 100));
}

console.log('\n=== 开头 240 字 ===');
console.log(text.slice(0, 240));
console.log('\n=== 结尾 240 字 ===');
console.log(text.slice(-240));
