/** 看目录预览里到底显示了什么 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9777;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(os.tmpdir(), `nf-toc-${Date.now()}`);
const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1500,1100',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
);

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
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/' });
  await sleep(4500);
  await ev(`(() => { const cards = Array.from(document.querySelectorAll('.shelf .lib-card')); const c = cards.find(x => x.textContent.includes('打脸结算系统')) ?? cards[0]; if (c) c.click(); return !!c; })()`);
  await sleep(2200);

  // 打开设定中心 → AI 生成目录
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.topbar button, button')).find(x => x.textContent.includes('设定中心')); if (b) b.click(); return !!b; })()`);
  await sleep(800);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.trim().includes('AI 生成目录')); if (b) b.click(); return !!b; })()`);
  await sleep(500);

  // 章数改成 3
  await ev(`(() => {
    const i = Array.from(document.querySelectorAll('.modal input[type=number]'))[0];
    if (!i) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, '3');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.includes('生成目录预览')); if (b) b.click(); return !!b; })()`);

  // 等预览出现
  let html = '';
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    html = await ev(`document.querySelector('.draft-outline')?.innerHTML ?? ''`);
    if (html) break;
  }
  console.log('=== 预览 DOM（前 600 字）===');
  console.log(html.slice(0, 600));
  console.log('\n=== 预览文本 ===');
  console.log((await ev(`document.querySelector('.draft-outline')?.innerText ?? '(空)'`)).slice(0, 400));

  ws.close();
} finally {
  child.kill();
}
