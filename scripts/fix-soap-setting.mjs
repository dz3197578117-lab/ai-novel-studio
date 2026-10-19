/** 修正《孤的肥皂》的制度设定：份例由内务府供给，太监私下索费 */
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
const ents = await api('GET', `/api/projects/${p.id}/entities`);
const byName = (n) => ents.find((e) => e.name === n);
console.log('项目:', p.title);

// 1. 修正「冬衣钱」——不是制度收费，是太监私索
const dongyi = byName('冬衣钱');
if (dongyi) {
  await api('PATCH', `/api/entities/${dongyi.id}`, {
    summary:
      '管事太监以「替您垫付内务府冬衣走账」为名私下索要的规费。制度上皇子冬衣由内务府按例供给，不收钱；这是太监的创收手段，名义上还得说是替主子办事。',
  });
  console.log('✓ 已修正：冬衣钱（改为太监私索，非制度收费）');
}

// 2. 修正「份例克扣」→ 说明真实机制
const fenli = byName('份例克扣');
if (fenli) {
  await api('PATCH', `/api/entities/${fenli.id}`, {
    name: '皇子分例',
    summary:
      '未封爵皇子由内务府按例供给月银、米粮、炭薪、衣料，封爵后改按爵位支俸银禄米，分府另有当铺田庄赏赐。主角未封爵、生母早逝、无外家，只按最低规格供给；再经内务府与管事太监层层抽头，到手炭湿米陈。',
  });
  console.log('✓ 已修正：份例克扣 → 皇子分例（补充真实供给机制）');
}

// 3. 补充关键设定
const NEW = [
  {
    type: 'faction',
    name: '内务府',
    summary:
      '掌宫廷供给、采买、营造。系统性腐败：连皇帝的采买都敢虚报（补条裤子报三千两、一个鸡蛋报三两银子），对无权无势的宗室更甚。',
    pinned: true,
  },
  {
    type: 'term',
    name: '门包',
    aliases: ['宫门费'],
    summary: '进某道门、见某个人之前必须给的私下银钱，太监的常规创收手段。',
    pinned: false,
  },
  {
    type: 'world',
    name: '宗室俸禄',
    summary:
      '清制：亲王岁俸银一万两、禄米一万斛；郡王五千两；贝勒二千五百两；贝子一千三百两。未封爵的皇子不给俸，只给分例。分府时赏当铺、田庄。',
    pinned: false,
  },
  {
    type: 'world',
    name: '主角出身',
    summary:
      '未封爵的冷门皇子，生母早逝、外家无人，在宗室序列里排位靠后。这是他待遇低到极点的制度性原因——不是因为要自己掏钱买冬衣。',
    pinned: true,
  },
];

for (const e of NEW) {
  if (byName(e.name)) continue;
  await api('POST', `/api/projects/${p.id}/entities`, e);
  console.log('✓ 新增设定:', e.name);
}

// 4. 知识库：把史实喂给后续生成
await api('POST', `/api/projects/${p.id}/knowledge`, {
  title: '清代皇子待遇与内务府腐败（史实参考）',
  source: '历史考据.md',
  tags: ['制度', '史实'],
  content: `一、制度层面
清代宗室待遇是严格的等级供给制。
1. 未封爵的皇子（阿哥）：由内务府按"皇子分例"供给月银、米粮、炭薪、衣料，规格按身份定，皇子本人不需要出钱购买冬衣。
2. 封爵之后：按爵位支给俸银禄米。亲王岁俸银一万两、禄米一万斛；郡王五千两；贝勒二千五百两；贝子一千三百两。
3. 分府时另有当铺、田庄、铺面等产业赏赐，作为长期收入来源。

二、腐败层面（真实存在，且系统性）
1. 内务府虚报成风：道光帝裤子打补丁，内务府报账三千两；光绪帝吃鸡蛋，内务府报价每枚三两银子，市价不过几文。
2. 太监创收：底层太监月钱极薄，靠"代办""垫付""走账"名义抽头；"门包""宫门费"是常规操作，光绪给慈禧请安时守门太监敢拦门索费。
3. 克扣对象：越是失宠、无外家撑腰的宗室，越容易被层屋克扣。

三、写作要点（避免制度硬伤）
1. 不要写成"朝廷向皇子收冬衣钱"——制度上不收。
2. 要写成：份例按最低规格发下来（因为主角未封爵、无外家），太监再扣一层，扣到手的炭是湿的、米是陈的。
3. "冬衣钱"只能是太监私下索要的规费，名义上还得说是替主子办事、垫付走账。
4. 主角若真亮出皇子身份，京兆府差役不敢查封其产业，会转而请罪或找更阴的手段——不要写"亮腰牌就解决"，要写"亮身份反而招来更大麻烦"。`,
});
console.log('✓ 已加入知识库：清代皇子待遇与内务府腐败（史实参考）');

// 5. 修正第 1 章大纲
const chs = await api('GET', `/api/projects/${p.id}/chapters`);
const ch1 = chs.find((c) => /第1章/.test(c.title));
await api('PATCH', `/api/chapters/${ch1.id}`, {
  outline:
    '现代社畜猝死后穿越成未封爵的冷门皇子，生母早逝、无外家，内务府只按最低规格给分例，管事太监再扣一层：炭是湿的、米是陈的。太监又以「替您垫付冬衣走账」为名上门索银。他压着原身记忆清点家底，在库房发现积压的猪油与灶灰，决定先活下去再弄钱。',
});
console.log('✓ 已修正第 1 章大纲（明确「制度供给 + 太监私扣」的因果）');

const after = await api('GET', `/api/projects/${p.id}/entities`);
console.log(`\n设定库：${after.length} 条`);
for (const e of after) console.log(`  [${e.type}] ${e.name}${e.pinned ? ' ⭐' : ''}`);
