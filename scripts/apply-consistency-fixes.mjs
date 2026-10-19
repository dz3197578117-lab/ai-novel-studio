/** 按一致性检查结果修正硬约束与设定 */
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

const RULES = `1. 背景为清代，制度必须符合史实。皇子份例由内务府按例供给，**不存在「向皇子收冬衣钱」这类制度性收费**。
2. 太监的一切索费只能以「代办、垫付、走账、门包」名义出现，写成私下规费，不能写成官方征收。
3. 主角未封爵、生母早逝、无外家，因此没有府邸、没有王府账房、没有属官。
4. 京师地方长官是**顺天府尹**，不在书中使用「京兆府」；京城治安由**五城兵马司**与**步军统领衙门**分掌。
5. 亮出皇子身份不是万能钥匙：顺天府、五城兵马司不会因身份就退让，反而会招来宗人府／内务府的过问。
6. 内务府腐败要写得「有账可查」：虚报价格（补丁三千两、鸡蛋三两一个）、以次充好、层层抽头，而不是直接抢。
7. 主角靠经商翻身，但宗室不得公然坐商，铺子必须挂在他人名下（太监、包衣、商人代持）。
8. 不出现火器、蒸汽机等超越时代的技术；制皂用灶灰滤碱＋猪油，造纸用竹麻沤料，均属当时可行工艺。
9. **称谓**：主角未封爵，自称「我」，他人称「阿哥」；「孤」「本王」仅用于书名玩梗，不得出现在正文叙述与台词中。
10. **立储制度**：本书为半架空——本朝仍立太子、有东宫建制（此为本书设定，不必与清代秘密立储完全一致）；其余制度按清代写。`;

await api('PATCH', `/api/projects/${p.id}`, { rules: RULES });
console.log('✓ 硬约束已更新（修正京兆府→顺天府，新增称谓与立储两条）');

const ents = await api('GET', `/api/projects/${p.id}/entities`);
const patchEntity = async (name, patch) => {
  const e = ents.find((x) => x.name === name);
  if (!e) return console.log('⚠ 找不到设定', name);
  await api('PATCH', `/api/entities/${e.id}`, patch);
  console.log('✓ 已修正设定:', name);
};

// 检查指出的：分例是定额照例，问题在成色与账实不符，不是「规格低」
await patchEntity('皇子分例', {
  summary:
    '未封爵皇子由内务府按「皇子分例」定额供给月银、米粮、炭薪、衣料，数额照例不少；封爵后改按爵位支俸银禄米，分府另有当铺田庄赏赐。让冷院「炭湿米陈」的不是规格低，而是内务府以次充好与管事太监层层抽头——**账面上数目一分不少，实物成色被压到最次**。',
});
await patchEntity('主角出身', {
  summary:
    '未封爵的冷门皇子，生母早逝、外家无人，在宗室序列里排位靠后。待遇低的根子是「无人替他盯账」：分例定额照发，实物却层层缩水，账实不符。这是他后来拿账本翻身的立论基础。',
});

// 「孤」的称谓问题：加一条设定，避免正文里出现
const hasTitle = ents.find((e) => e.name === '称谓规矩');
if (!hasTitle) {
  await api('POST', `/api/projects/${p.id}/entities`, {
    type: 'term',
    name: '称谓规矩',
    summary:
      '主角未封爵，自称「我」，旁人称「阿哥」。「孤」「本王」「本王」只出现在书名玩梗，正文台词与叙述一律不用。',
    pinned: true,
  });
  console.log('✓ 新增设定: 称谓规矩');
}

const after = await api('GET', `/api/projects/${p.id}`);
const entsAfter = await api('GET', `/api/projects/${p.id}/entities`);
console.log(`\n硬约束 ${after.rules.length} 字 / 设定 ${entsAfter.length} 条`);
console.log('--- 新增的两条硬约束 ---');
console.log(after.rules.split('\n').slice(-2).join('\n'));
