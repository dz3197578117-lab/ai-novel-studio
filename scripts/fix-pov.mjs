/** 写入视角硬约束，并用新约束重生成第1章细纲与场景卡 */
const B = 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const rules = (await api('GET', `/api/projects/${p.id}`)).rules;

const extra = `
11. **视角**：全文**第一人称限知**，叙述者是主角本人（「我」）。不得切换成第三人称，不得写主角看不到、听不到、推断不出的信息；其他角色的心理只能通过表情、动作、台词体现。
12. **规划材料同样用第一人称**：章节大纲、细纲、场景卡都用「我」写，不要出现「他」指代主角，否则续写时会串视角。
13. **称谓**：太监、下人、外臣称主角「阿哥」（或「X阿哥」），不称「殿下」「王爷」「主子」；主角自称「我」。`;

if (!rules.includes('第一人称限知')) {
  await api('PATCH', `/api/projects/${p.id}`, { rules: rules + '\n' + extra });
  console.log('✓ 已补入视角与称谓硬约束');
}

const chs = await api('GET', `/api/projects/${p.id}/chapters`);
const ch1 = chs.find((c) => /第1章/.test(c.title));

console.log('\n=== 重新生成细纲 ===');
const beats = await api('POST', '/api/ai/chapter-beats', { projectId: p.id, chapterId: ch1.id });
console.log(beats.beats.slice(0, 700));

console.log('\n=== 重新生成场景卡 ===');
const scenes = await api('POST', '/api/ai/scene-cards', { projectId: p.id, chapterId: ch1.id });
for (const s of scenes.scenes) {
  console.log(`  ${s.title} | pov=${s.pov} | @${s.location}`);
  if (s.keyLines) console.log(`     台词：${s.keyLines.slice(0, 50)}`);
}

// 检查是否还残留第三人称
const allBeats = beats.beats;
const heCount = (allBeats.match(/他/g) ?? []).length;
const meCount = (allBeats.match(/我/g) ?? []).length;
console.log(`\n细纲人称：我 ${meCount} 次 / 他 ${heCount} 次`);
const dianxia = scenes.scenes.filter((s) => (s.keyLines ?? '').includes('殿下')).length;
console.log(`场景卡里出现「殿下」：${dianxia} 处`);
