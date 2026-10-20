/** 截图并测量「写作前准备区」的排版 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9911;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(os.tmpdir(), `nf-prep-${Date.now()}`);
const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1400,1000',
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
  await sleep(2600);

  // 展开规划区
  await ev(`(() => {
    const btns = Array.from(document.querySelectorAll('.prep button'));
    const b = btns.find(x => x.textContent.trim() === '展开');
    if (b) b.click(); return !!b;
  })()`);
  await sleep(800);

  // 展开查资料（如果有 查看 按钮）
  await ev(`(() => {
    const b = Array.from(document.querySelectorAll('.prep button')).find(x => x.textContent.trim() === '查看');
    if (b) b.click(); return !!b;
  })()`);
  await sleep(600);

  const metrics = await ev(`(() => {
    const q = (s) => document.querySelector(s);
    const rect = (el) => el ? { h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) } : null;
    const prep = q('.prep');
    const facts = q('.facts');
    const factsBody = q('.facts-body');
    const factsFoot = q('.facts-foot');
    const fiction = q('textarea.fiction');
    const inner = q('.editor-inner');
    return {
      prep: rect(prep),
      facts: rect(facts),
      factsBody: rect(factsBody),
      factsFoot: rect(factsFoot),
      factsScrollable: factsBody ? factsBody.scrollHeight > factsBody.clientHeight + 2 : false,
      fiction: rect(fiction),
      innerScrollable: inner ? inner.scrollHeight > inner.clientHeight + 2 : false,
      prepHeads: document.querySelectorAll('.prep-head').length,
      factsItems: document.querySelectorAll('.facts-item').length,
      planResult: !!q('.plan-result'),
    };
  })()`);
  console.log(JSON.stringify(metrics, null, 2));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(os.tmpdir(), 'prep-layout.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('截图:', file);

  // 只截 prep 区域
  const clip = await ev(`(() => {
    const r = document.querySelector('.prep').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  const shot2 = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1.5 } });
  const file2 = path.join(os.tmpdir(), 'prep-only.png');
  fs.writeFileSync(file2, Buffer.from(shot2.data, 'base64'));
  console.log('局部截图:', file2);

  ws.close();
} finally {
  child.kill();
}
