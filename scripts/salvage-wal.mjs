/**
 * 从 WAL 里按锚点提取大窗口文本，用于抢救被删章节正文。
 */
import fs from 'node:fs';
import path from 'node:path';

const walPath = process.argv[2];
if (!walPath) {
  console.error('用法: node scripts/salvage-wal.mjs <path-to.db-wal>');
  process.exit(1);
}
const buf = fs.readFileSync(walPath);
const text = buf.toString('utf8');

const ANCHORS = [
  '雪落了三日',
  '外院的废宅比祠堂更冷',
  '露出黑黢黢的椽木',
  '晚正把雪铲到墙根',
  '林尘站起来，将断剑插进腰间',
];

const outDir = path.dirname(walPath);
const outFile = path.join(outDir, 'salvaged-windows.txt');
const parts = [];

for (const anchor of ANCHORS) {
  let from = 0;
  let nth = 0;
  while (true) {
    const idx = text.indexOf(anchor, from);
    if (idx < 0) break;
    nth++;
    from = idx + anchor.length;

    const start = Math.max(0, idx - 200);
    const end = Math.min(text.length, idx + 4000);
    const window = text.slice(start, end);

    // 只保留可打印字符，把二进制噪声换成换行，便于人工查看
    const printable = window
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();

    parts.push(`===== 锚点「${anchor}」第 ${nth} 处 =====\n${printable}\n`);
  }
}

fs.writeFileSync(outFile, parts.join('\n'), 'utf8');
console.log('写入:', outFile, '| 片段数:', parts.length);
console.log(parts.map((p) => p.split('\n')[0]).join('\n'));
