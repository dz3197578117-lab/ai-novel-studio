/** 把第 1 章正文写入《孤的肥皂》，并据文本建立设定条目 */
const B = 'http://127.0.0.1:8787';
const api = async (m, p, b) => {
  const r = await fetch(`${B}${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
};

const CONTENT = `社畜猝死后在冷院醒来，成了连份例都被克扣的冷门皇子：炭是湿的、米是陈的，管事太监还来催缴“冬衣钱”。他压着原身记忆清点家底，发现库房里堆着几缸没人要的猪油和灶灰，小太监哭着说这日子没法过。他盯着那堆东西笑了：先活下去，再想法子弄钱。`;

const projects = await api('GET', '/api/projects');
const p = projects.find((x) => x.title.includes('孤的肥皂'));
if (!p) throw new Error('找不到《孤的肥皂》');
console.log('目标项目:', p.title, p.id);

const chapters = await api('GET', `/api/projects/${p.id}/chapters`);
const first = chapters.find((c) => /第1章/.test(c.title)) ?? chapters[0];
console.log('目标章节:', first.title, first.id);

// 1. 写入正文 + 大纲
const updated = await api('PATCH', `/api/chapters/${first.id}`, {
  content: CONTENT,
  outline:
    '现代社畜猝死后穿越成冷院皇子，份例被克扣到极点（湿炭、陈米），管事太监上门催缴“冬衣钱”。他压着原身记忆清点家底，在库房发现积压的猪油与灶灰，决定先活下去再弄钱。',
  status: 'drafting',
});
console.log(`第1章已写入：${updated.wordCount} 字，状态 ${updated.status}`);

// 2. 建设定（只写文本里出现过的，不编造专名）
const ENTITIES = [
  {
    type: 'character',
    name: '冷院皇子',
    aliases: [],
    summary:
      '现代社畜猝死后穿越而来，住在冷院，份例被克扣到极点。压着原身的记忆，缺钱但不缺脑子，遇事先算账。',
    pinned: true,
  },
  {
    type: 'character',
    name: '管事太监',
    aliases: ['管事'],
    summary: '负责冷院份例的内廷管事，惯于克扣与勒索，以“冬衣钱”等名目向冷院伸手。',
    pinned: false,
  },
  {
    type: 'character',
    name: '小太监',
    aliases: [],
    summary: '冷院随侍的小太监，胆小怕事，一遇克扣就哭“这日子没法过”。',
    pinned: false,
  },
  {
    type: 'location',
    name: '冷院',
    aliases: [],
    summary: '冷门皇子居所，墙薄窗漏，炭是湿的、米是陈的，是份例被克扣到极点的具象。',
    pinned: true,
  },
  {
    type: 'item',
    name: '猪油',
    aliases: [],
    summary: '库房里积压的几缸猪油，无人问津。主角翻身的第一笔本钱（可制皂）。',
    pinned: true,
  },
  {
    type: 'item',
    name: '灶灰',
    aliases: [],
    summary: '和猪油一起堆在库房的灶灰。制皂的另一味原料，被所有人当垃圾。',
    pinned: true,
  },
  {
    type: 'term',
    name: '冬衣钱',
    aliases: [],
    summary: '管事太监以冬日置装为名向冷院额外勒索的银钱，属于克扣之外的二次盘剥。',
    pinned: false,
  },
  {
    type: 'world',
    name: '份例克扣',
    aliases: [],
    summary: '内廷按例发放的月米、炭火、衣料，经管事之手层层短缺；冷门皇子几乎没有议价能力。',
    pinned: false,
  },
];

let created = 0;
for (const e of ENTITIES) {
  await api('POST', `/api/projects/${p.id}/entities`, e);
  created++;
}
console.log(`设定条目已创建：${created} 条`);

const after = await api('GET', `/api/projects/${p.id}/entities`);
console.log('\n当前设定库：');
for (const e of after) console.log(`  [${e.type}] ${e.name} — ${e.summary.slice(0, 36)}`);

const ov = await (await fetch(`${B}/api/projects/overview`)).json();
const me = ov.find((x) => x.id === p.id);
console.log(`\n项目状态：${me.chapterCount} 章 / ${me.wordCount} 字 / ${me.entityCount} 设定`);
