/**
 * 把《打脸结算系统》补到 300 章（只出章节名，分卷推进）。
 * 用法: node scripts/fill-to-300.mjs
 */
const B = 'http://127.0.0.1:8787';
const TARGET = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (method, path, body) => {
  const r = await fetch(`${B}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
};

async function waitJob(jobId) {
  for (let i = 0; i < 400; i++) {
    await sleep(3000);
    const job = await (await fetch(`${B}/api/jobs/${jobId}`)).json();
    if (job.status !== 'running') return job;
  }
  throw new Error('任务超时');
}

const projects = await api('GET', '/api/projects');
const p = projects.find((x) => x.title === '打脸结算系统');
if (!p) throw new Error('找不到《打脸结算系统》');

const before = await api('GET', `/api/projects/${p.id}/chapters`);
console.log(`当前 ${before.length} 章，目标 ${TARGET} 章，需补 ${TARGET - before.length} 章`);

/** 分卷计划：每卷约 47 章 */
const VOLUMES = [
  { title: '第二卷 · 资本围猎', count: 47, hint: '进入资本圈，被更大的玩家盯上，打脸层次升级' },
  { title: '第三卷 · 云顶起势', count: 47, hint: '建立自己的公司，从被踩到踩人，团队与对手登场' },
  { title: '第四卷 · 商战正酣', count: 47, hint: '正面商战：断供、挖人、舆论战、资本狙击' },
  { title: '第五卷 · 猎手反噬', count: 47, hint: '猎手身份揭晓，主角开始反向结算对方' },
  { title: '第六卷 · 资本暗战', count: 47, hint: '暗线博弈：股份战争、监管、家族内斗' },
  { title: '第七卷 · 结算终局', count: 44, hint: '终局对决，系统来历揭晓，收束所有伏笔' },
];

const total = VOLUMES.reduce((s, v) => s + v.count, 0);
const need = TARGET - before.length;
if (total !== need) console.log(`⚠ 计划 ${total} 章，实际需要 ${need} 章`);

const sw = Date.now();
for (const [idx, v] of VOLUMES.entries()) {
  const cur = (await api('GET', `/api/projects/${p.id}/chapters`)).length;
  if (cur >= TARGET) break;
  const count = Math.min(v.count, TARGET - cur);
  console.log(`\n[${idx + 1}/${VOLUMES.length}] ${v.title} — 生成 ${count} 章（当前 ${cur} 章）`);

  const started = await api('POST', `/api/projects/${p.id}/expand-volume`, {
    volumeTitle: v.title,
    chapterCount: count,
    titlesOnly: true,
    instruction: v.hint,
  });
  const job = await waitJob(started.jobId);
  if (job.status !== 'done') throw new Error(`${v.title} 生成失败：${job.error}`);

  const chapters = job.result.chapters;
  const applied = await api('POST', `/api/projects/${p.id}/apply-volume-chapters`, {
    volumeTitle: job.result.volumeTitle,
    volumeSummary: job.result.volumeSummary,
    chapters,
  });
  console.log(`  写入 ${applied.counts.chapters} 章：${chapters[0].title} → ${chapters[chapters.length - 1].title}`);
}

const after = await api('GET', `/api/projects/${p.id}/chapters`);
const vols = await api('GET', `/api/projects/${p.id}/volumes`);
console.log(`\n=== 完成 ===`);
console.log(`章节总数：${after.length} / ${TARGET}，耗时 ${((Date.now() - sw) / 60000).toFixed(1)} 分钟`);
console.log(`卷结构：`);
for (const v of vols) {
  console.log(`  ${v.title} — ${after.filter((c) => c.volumeId === v.id).length} 章`);
}
const orphans = after.filter((c) => !c.volumeId).length;
if (orphans) console.log(`  （未归卷 ${orphans} 章）`);

// 抽样看编号是否连续
const titles = after.map((c) => c.title);
const nums = titles
  .map((t) => /^第(\d+)章/.exec(t)?.[1])
  .filter(Boolean)
  .map(Number);
const maxNum = nums.length ? Math.max(...nums) : 0;
console.log(`\n阿拉伯数字编号的章节：${nums.length} 个，最大第${maxNum}章`);
const dupNums = nums.filter((n, i) => nums.indexOf(n) !== i);
console.log(`重复编号：${dupNums.length ? [...new Set(dupNums)].join(',') : '无'}`);
