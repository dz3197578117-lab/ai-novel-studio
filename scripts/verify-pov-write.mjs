/** 把大纲改成第一人称，并验证续写不会串视角 */
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
const ch1 = chs.find((c) => /第1章/.test(c.title));

console.log('=== 把大纲改成第一人称 ===');
const rev = await api('POST', '/api/ai/revise-plan', {
  projectId: p.id,
  chapterId: ch1.id,
  field: 'outline',
  mode: 'revise',
  instruction: '把这段大纲改成第一人称（用「我」），保持事件与顺序不变，控制在 100 字内。',
});
console.log(rev.text);
await api('PATCH', `/api/chapters/${ch1.id}`, { outline: rev.text });
console.log('✓ 大纲已更新');

console.log('\n=== 验证续写视角 ===');
const res = await fetch(`${B}/api/write/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    projectId: p.id,
    chapterId: ch1.id,
    mode: 'continue',
    instruction: '接最后一段，写得具体一点',
    selectedText: '',
  }),
});
const raw = await res.text();
const deltas = raw
  .split('\n\n')
  .filter((l) => l.startsWith('data: '))
  .map((l) => {
    try { return JSON.parse(l.slice(6)); } catch { return null; }
  })
  .filter(Boolean);

const text = deltas.filter((d) => d.type === 'delta').map((d) => d.text).join('');
const done = deltas.find((d) => d.type === 'done');
console.log('续写长度:', text.length, '字');
console.log('续写开头:', text.slice(0, 160).replace(/\n/g, ' '));
console.log('续写结尾:', (done?.fullText ?? text).slice(-120).replace(/\n/g, ' '));

const me = (text.match(/我/g) ?? []).length;
const he = (text.match(/他/g) ?? []).length;
const dianxia = (text.match(/殿下/g) ?? []).length;
console.log(`\n人称统计：我 ${me} 次 / 他 ${he} 次 / 殿下 ${dianxia} 次`);
console.log(me > he ? '✓ 第一人称主导' : '✗ 视角可能串了');
