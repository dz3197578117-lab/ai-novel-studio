/** 修正与制度史实冲突的章节大纲（第3、8、11章） */
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

const projects = await api('GET', '/api/projects');
const p = projects.find((x) => x.title.includes('孤的肥皂'));
const chs = await api('GET', `/api/projects/${p.id}/chapters`);
const find = (n) => chs.find((c) => c.title.startsWith(`第${n}章`));

const FIX = [
  {
    n: 3,
    title: '第3章 · 东市摆摊',
    outline:
      '他不敢以皇子的脸面亲自出摊，让小太监在东市角落摆摊，自己在对面茶棚看着。邻摊笑这是"泥疙瘩皂"，一富户婆子试用后当场买走三块。地头蛇晃过来撂下"这摊子归我管"，他才出面谈，几句话把抽成压到一成。婆子临走回头，说我家夫人想见你——两条线同时打开：市井与内宅。',
    reason: '皇子亲自站街摆摊不合身份，也容易被认出；改为幕后看着、地头蛇上门才现身',
  },
  {
    n: 8,
    title: '第8章 · 公事钱',
    outline:
      '五城兵马司的兵丁以"市井货无引"查摊，把半摊皂全收走。他去讨货，对方开口要"公事钱"二十两。他压着火交了，回来才想明白：不是货犯法，是有人递了话。这二十两买到的是一条信息——有人不想让他把皂铺开。当夜他把这几个月的进项、打点、损失全列成账，第一次认真算"要在这城里站住，需要多少银子"。',
    reason: '京兆府不敢查封皇子产业，"亮腰牌解决"是硬伤；改为五城兵马司（掌街市治安）敲竹杠，且亮身份只会更麻烦',
  },
  {
    n: 11,
    title: '第11章 · 内务府的账',
    outline:
      '他借送纸入宫之机，在内务府采买房外候着，看见几笔账：一枚鸡蛋报三两、一条补丁报三千两。他用现代记账法在心里过了一遍，估出这套账一年能吞多少银子，也第一次看清"克扣"不是某个太监贪，是整台机器在吃人。他没吭声，只把几个数字记牢——这是将来掀桌子的第一块砖。',
    reason: '未封爵皇子没有王府、也没有账房；改为他窥见内务府采买账，既合身份也更有张力',
  },
];

for (const f of FIX) {
  const c = find(f.n);
  if (!c) {
    console.log(`⚠ 找不到第${f.n}章`);
    continue;
  }
  await api('PATCH', `/api/chapters/${c.id}`, { title: f.title, outline: f.outline });
  console.log(`✓ 第${f.n}章已修正：${f.title}`);
  console.log(`  原因：${f.reason}`);
}

const after = await api('GET', `/api/projects/${p.id}/chapters`);
console.log('\n=== 前 6 章大纲现状 ===');
for (const c of after.slice(0, 6)) {
  const full = await (await fetch(`${B}/api/chapters/${c.id}`)).json();
  console.log(`\n${full.title}`);
  console.log(`  ${full.outline || '（无大纲）'}`);
}
