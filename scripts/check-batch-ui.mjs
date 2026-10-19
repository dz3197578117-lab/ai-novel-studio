/** 临时验证：侧边栏多选与搜索可用，且不删除任何数据 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9666;
const UI = 'http://127.0.0.1:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(os.tmpdir(), `nf-batch-${Date.now()}`);
const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1500,1000',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
);

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
    } catch { /* retry */ }
    await sleep(250);
  }
  const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: UI });
  await sleep(4200);

  // 进入项目
  await ev(`(() => {
    const cards = Array.from(document.querySelectorAll('.shelf .lib-card'));
    const c = cards.find(x => x.textContent.includes('打脸结算系统')) ?? cards[0];
    if (c) c.click(); return !!c;
  })()`);
  await sleep(2200);

  const hasMulti = await ev(`Array.from(document.querySelectorAll('.sidebar button')).some(b => b.textContent.trim() === '多选')`);
  console.log(`${hasMulti ? 'PASS' : 'FAIL'}  目录区有「多选」按钮`);

  const hasSearch = await ev(`!!Array.from(document.querySelectorAll('.sidebar input')).find(i => (i.placeholder||'').includes('搜索章节'))`);
  console.log(`${hasSearch ? 'PASS' : 'FAIL'}  有章节搜索框`);

  await ev(`(() => { const b = Array.from(document.querySelectorAll('.sidebar button')).find(x => x.textContent.trim() === '多选'); if (b) b.click(); return true; })()`);
  await sleep(500);

  const bar = await ev(`!!document.querySelector('.batch-bar')`);
  console.log(`${bar ? 'PASS' : 'FAIL'}  进入多选后出现批量操作栏`);

  const boxes = await ev(`document.querySelectorAll('.chapter-check').length`);
  const itemsBefore = await ev(`document.querySelectorAll('.chapter-item').length`);
  console.log(`${boxes > 0 ? 'PASS' : 'FAIL'}  章节出现勾选框（${boxes} 个）`);

  // 勾选前两个
  await ev(`(() => {
    const items = Array.from(document.querySelectorAll('.chapter-item')).slice(0, 2);
    items.forEach(i => i.click());
    return items.length;
  })()`);
  await sleep(400);
  const info = await ev(`document.querySelector('.batch-info')?.textContent ?? ''`);
  console.log(`${/已选 2/.test(info) ? 'PASS' : 'FAIL'}  计数正确：${info.trim()}`);

  const btnState = await ev(`(() => {
    const btns = Array.from(document.querySelectorAll('.batch-bar button'));
    return btns.map(b => b.textContent.trim() + ':' + (b.disabled ? 'disabled' : 'enabled')).join(',');
  })()`);
  console.log(`INFO  按钮状态：${btnState}`);

  // 搜索过滤
  await ev(`(() => {
    const i = Array.from(document.querySelectorAll('.sidebar input')).find(x => (x.placeholder||'').includes('搜索章节'));
    if (!i) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, '第3');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const filtered = await ev(`document.querySelectorAll('.chapter-item').length`);
  console.log(`${filtered >= 1 && filtered < boxes ? 'PASS' : 'INFO'}  搜索后章节数：${filtered}`);

  // 清空搜索再退出多选，确认没有删除
  await ev(`(() => {
    const i = Array.from(document.querySelectorAll('.sidebar input')).find(x => (x.placeholder||'').includes('搜索章节'));
    if (!i) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.sidebar button')).find(x => x.textContent.trim() === '多选'); if (b) b.click(); return true; })()`);
  await sleep(400);
  const after = await ev(`document.querySelectorAll('.chapter-item').length`);
  console.log(`${after === itemsBefore ? 'PASS' : 'FAIL'}  退出多选后章节数不变（${after}/${itemsBefore}）`);

  ws.close();
} finally {
  child.kill();
}
