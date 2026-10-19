/** 验证编辑器布局：正文字高度、滚动可达性、规划区折叠 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9888;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(os.tmpdir(), `nf-layout-${Date.now()}`);
const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1400,900',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
);
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* */ }
    await sleep(250);
  }
  const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const send = (m, p = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/' });
  await sleep(4500);

  await ev(`(() => {
    const cards = Array.from(document.querySelectorAll('.shelf .lib-card'));
    const c = cards.find(x => x.textContent.includes('孤的肥皂')) ?? cards[0];
    if (c) c.click(); return !!c;
  })()`);
  await sleep(2500);

  const metrics = await ev(`(() => {
    const f = document.querySelector('textarea.fiction');
    const inner = document.querySelector('.editor-inner');
    const body = document.querySelector('.editor-body');
    const bar = document.querySelector('.layers-bar');
    return {
      fictionH: f ? Math.round(f.getBoundingClientRect().height) : -1,
      fictionScrollable: f ? f.scrollHeight > f.clientHeight : false,
      innerScrollable: inner ? inner.scrollHeight > inner.clientHeight + 2 : false,
      bodyOverflow: body ? getComputedStyle(body).overflow : '',
      hasBar: !!bar,
      words: f ? f.value.length : 0,
    };
  })()`);
  console.log('布局数据:', JSON.stringify(metrics));
  check('规划区折叠条存在', metrics.hasBar);
  check('正文可见高度 ≥ 300px', metrics.fictionH >= 300, `${metrics.fictionH}px`);
  check('正文有内容', metrics.words > 100, `${metrics.words} 字`);

  // 展开规划区
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.layers-bar button'))[0]; if (b) b.click(); return !!b; })()`);
  await sleep(600);
  const expanded = await ev(`(() => {
    const f = document.querySelector('textarea.fiction');
    const inner = document.querySelector('.editor-inner');
    return {
      fictionH: f ? Math.round(f.getBoundingClientRect().height) : -1,
      innerScrollable: inner ? inner.scrollHeight > inner.clientHeight + 2 : false,
      innerScrollTopMax: inner ? inner.scrollHeight - inner.clientHeight : 0,
    };
  })()`);
  console.log('展开后:', JSON.stringify(expanded));
  check('展开后正文仍有高度 ≥ 300px', expanded.fictionH >= 300, `${expanded.fictionH}px`);
  check('展开后整列可滚动（能滚到正文）', expanded.innerScrollable, `可滚 ${expanded.innerScrollTopMax}px`);

  // 滚到底部，确认正文字区能进入视口
  const reachable = await ev(`(async () => {
    const inner = document.querySelector('.editor-inner');
    if (inner) inner.scrollTop = inner.scrollHeight;
    await new Promise(r => setTimeout(r, 300));
    const f = document.querySelector('textarea.fiction');
    const r = f.getBoundingClientRect();
    const vh = window.innerHeight;
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh };
  })()`);
  console.log('滚动后正文位置:', JSON.stringify(reachable));
  check('滚动后正文可见', reachable.top < reachable.vh - 100, `top=${reachable.top}, vh=${reachable.vh}`);

  ws.close();
} finally {
  child.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
