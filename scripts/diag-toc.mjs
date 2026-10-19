/** 诊断：生成目录时到底有没有产出每章大纲 */
const B = 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const projects = await (await fetch(`${B}/api/projects`)).json();
const p = projects.find((x) => x.title === '打脸结算系统') ?? projects[0];

const start = await (
  await fetch(`${B}/api/projects/${p.id}/generate-toc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapterCount: Number(process.argv[2] ?? 6) }),
  })
).json();

console.log('jobId =', start.jobId, '批次 =', start.batches);

let job;
for (let i = 0; i < 80; i++) {
  await sleep(3000);
  job = await (await fetch(`${B}/api/jobs/${start.jobId}`)).json();
  if (job.status !== 'running') break;
}

console.log('状态 =', job.status, '章数 =', job.result?.chapters?.length ?? 0);
if (job.error) console.log('错误 =', job.error);

const chapters = job.result?.chapters ?? [];
for (const c of chapters) {
  const outline = c.outline ?? '';
  console.log(`  卷${c.volumeIndex} | ${c.title} | 大纲 ${outline.length} 字`);
  if (outline) console.log(`      ${outline.slice(0, 60)}`);
}

const withOutline = chapters.filter((c) => (c.outline ?? '').length > 10).length;
console.log(`\n有实质大纲的章节：${withOutline}/${chapters.length}`);
