/** 真实模型验证：写前自查整改 */
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

const before = await api('GET', `/api/chapters/${ch1.id}`);
console.log('=== 整改前大纲 ===');
console.log(before.outline);
console.log(`\n（已有核查点 ${(before.facts ?? []).length} 条）`);

const sw = Date.now();
const r = await api('POST', `/api/chapters/${ch1.id}/self-fix`, { apply: false });
console.log(`\n耗时 ${((Date.now() - sw) / 1000).toFixed(1)}s | 检索到 ${r.hitCount} 段资料 | ${r.changes.length} 条改动说明`);

console.log('\n=== 整改后大纲 ===');
console.log(r.outline);

console.log('\n=== 改动依据 ===');
for (const c of r.changes) {
  const tag = c.verdict === 'fixed' ? '已改' : c.verdict === 'ok' ? '符合' : '资料未覆盖';
  console.log(`\n[${tag}] ${c.point}`);
  console.log(`  ${c.action}${c.source ? `（依据：${c.source}）` : ''}`);
}

if (r.beats) {
  console.log('\n=== 整改后细纲（前 400 字）===');
  console.log(r.beats.slice(0, 400));
}

const after = await api('GET', `/api/chapters/${ch1.id}`);
console.log('\n未 apply → 章节未被改动:', after.outline === before.outline);
