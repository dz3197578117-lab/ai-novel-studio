/** 检查《孤的肥皂》第1章的视角一致性 */
const B = 'http://127.0.0.1:8787';
const get = async (p) => (await fetch(`${B}${p}`)).json();

const projects = await get('/api/projects');
const p = projects.find((x) => x.title.includes('孤的肥皂'));
const chs = await get(`/api/projects/${p.id}/chapters`);
const ch1 = chs.find((c) => /第1章/.test(c.title));
const full = await get(`/api/chapters/${ch1.id}`);
const scenes = await get(`/api/chapters/${ch1.id}/scenes`);

console.log('=== 章节 ===');
console.log(ch1.title, '|', full.wordCount, '字');
console.log('\n=== 大纲 ===');
console.log(full.outline);
console.log('\n=== 细纲 ===');
console.log((full.beats || '(无)').slice(0, 800));

console.log('\n=== 场景卡 POV 字段 ===');
for (const [i, s] of scenes.entries()) {
  console.log(`  ${i + 1}. ${s.title} | pov="${s.pov}" | @${s.location}`);
}

console.log('\n=== 正文（前 900 字）===');
console.log(full.content.slice(0, 900));

console.log('\n=== 正文（后 600 字）===');
console.log(full.content.slice(-600));

// 人称统计
const text = full.content;
const stat = {
  第一人称我: (text.match(/我/g) ?? []).length,
  第一人称咱: (text.match(/咱/g) ?? []).length,
  第三人称他: (text.match(/他/g) ?? []).length,
  第二人称你: (text.match(/你/g) ?? []).length,
  殿下一词: (text.match(/殿下/g) ?? []).length,
};
console.log('\n=== 人称词频 ===');
console.log(JSON.stringify(stat));

// 找出「我」出现的上下文
const around = [];
let idx = text.indexOf('我');
let n = 0;
while (idx >= 0 && n < 6) {
  around.push(text.slice(Math.max(0, idx - 30), idx + 30).replace(/\n/g, ' '));
  idx = text.indexOf('我', idx + 1);
  n++;
}
console.log('\n=== 「我」的上下文 ===');
for (const a of around) console.log('  …' + a + '…');
