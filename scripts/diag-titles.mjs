/** 验证：只出章节名的速度 + 后期补大纲 */
const B = 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (method, path, body) => {
  const r = await fetch(`${B}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};

async function waitJob(jobId, label) {
  const sw = Date.now();
  let job;
  for (let i = 0; i < 300; i++) {
    await sleep(3000);
    job = await (await fetch(`${B}/api/jobs/${jobId}`)).json();
    if (job.status !== 'running') break;
    if (i % 3 === 0) {
      console.log(`  [${Math.round((Date.now() - sw) / 1000)}s] ${label} ${job.progress.done}/${job.progress.total}`);
    }
  }
  return { job, seconds: (Date.now() - sw) / 1000 };
}

const proj = await api('POST', '/api/projects', {
  title: '只出章节名测试',
  logline: '一个修仙者在大雪封山时重返宗门',
  genre: '东方玄幻',
});

try {
  console.log('=== 生成 100 个章节名（不含大纲）===');
  const started = await api('POST', `/api/projects/${proj.id}/generate-toc`, {
    chapterCount: 100,
    titlesOnly: true,
  });
  console.log('批次 =', started.batches, '|', started.message);
  const { job, seconds } = await waitJob(started.jobId, '标题');
  console.log(`状态 = ${job.status}，耗时 ${seconds.toFixed(1)} 秒`);
  if (job.error) throw new Error(job.error);

  const plan = job.result;
  const withOutline = plan.chapters.filter((c) => (c.outline ?? '').length > 0).length;
  console.log(`生成 ${plan.chapters.length} 章，其中有大纲的 ${withOutline} 章（应为 0）`);
  console.log('前 5 个标题：', plan.chapters.slice(0, 5).map((c) => c.title).join(' / '));

  console.log('\n=== 写入作品 ===');
  const applied = await api('POST', `/api/projects/${proj.id}/apply-toc`, {
    volumes: plan.volumes,
    chapters: plan.chapters,
  });
  console.log('写入 =', JSON.stringify(applied.counts));

  const chapters = await api('GET', `/api/projects/${proj.id}/chapters`);
  console.log('落库章节数 =', chapters.length);

  console.log('\n=== 只给前 5 章补大纲 ===');
  const ids = chapters.slice(0, 5).map((c) => c.id);
  const fill = await api('POST', `/api/projects/${proj.id}/fill-outlines`, { ids });
  const filled = await waitJob(fill.jobId, '大纲');
  console.log(`状态 = ${filled.job.status}，耗时 ${filled.seconds.toFixed(1)} 秒`);
  console.log('结果 =', JSON.stringify(filled.job.result));

  const after = await Promise.all(
    ids.map(async (id) => (await (await fetch(`${B}/api/chapters/${id}`)).json())),
  );
  for (const c of after) {
    console.log(`  ${c.title} | 大纲 ${(c.outline ?? '').length} 字 | ${(c.outline ?? '').slice(0, 40)}`);
  }
  const ok = after.filter((c) => (c.outline ?? '').length > 10).length;
  console.log(`\n前 5 章补到大纲的：${ok}/5`);

  // 后续章节应仍为空
  const tail = await (await fetch(`${B}/api/chapters/${chapters[50].id}`)).json();
  console.log(`第 51 章大纲（应为空）：${(tail.outline ?? '').length} 字`);
} finally {
  await fetch(`${B}/api/projects/${proj.id}`, { method: 'DELETE' });
  console.log('已清理临时项目');
}
