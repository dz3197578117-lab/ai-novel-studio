/** 诊断：目录写入后，章节大纲是否还在 */
const B = 'http://127.0.0.1:8787';
const jobId = process.argv[2];
if (!jobId) {
  console.log('用法: node scripts/diag-apply-toc.mjs <jobId>');
  process.exit(1);
}

const post = async (path, body) => {
  const r = await fetch(`${B}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};

const job = await (await fetch(`${B}/api/jobs/${jobId}`)).json();
const plan = job.result;
console.log('计划章数 =', plan.chapters.length);
console.log('计划里有大纲的 =', plan.chapters.filter((c) => (c.outline ?? '').length > 10).length);

const proj = await post('/api/projects', { title: '目录写入诊断' });
try {
  const applied = await post(`/api/projects/${proj.id}/apply-toc`, {
    volumes: plan.volumes,
    chapters: plan.chapters,
  });
  console.log('写入结果 =', JSON.stringify(applied.counts));

  const chapters = await (await fetch(`${B}/api/projects/${proj.id}/chapters`)).json();
  console.log('落库章节数 =', chapters.length);

  let withOutline = 0;
  for (const c of chapters.slice(0, 10)) {
    const full = await (await fetch(`${B}/api/chapters/${c.id}`)).json();
    const len = (full.outline ?? '').length;
    if (len > 10) withOutline++;
    console.log(`  ${full.title} | 大纲 ${len} 字${len ? ` | ${full.outline.slice(0, 30)}` : ' ⚠ 空'}`);
  }
  console.log(`\n前 10 章中有大纲的：${withOutline}/10`);
} finally {
  await fetch(`${B}/api/projects/${proj.id}`, { method: 'DELETE' });
  console.log('已清理临时项目');
}
