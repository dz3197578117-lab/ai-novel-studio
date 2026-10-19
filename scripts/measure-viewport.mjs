/**
 * 在多种设备宽度下测量真实布局，判断是否溢出。
 * 用 CDP 的 Emulation.setDeviceMetricsOverride 精确模拟视口。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9555;
const TARGET = process.env.TARGET_URL ?? 'http://127.0.0.1:5173/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEVICES = [
  { name: 'iPhone SE', w: 375, h: 667 },
  { name: 'iPhone 14', w: 390, h: 844 },
  { name: 'iPad mini', w: 768, h: 1024 },
  { name: '笔记本', w: 1366, h: 768 },
  { name: '桌面', w: 1920, h: 1080 },
];

async function main() {
  const profile = path.join(os.tmpdir(), `nf-vp-${Date.now()}`);
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        if (r.ok) break;
      } catch {
        /* retry */
      }
      await sleep(250);
    }

    const page = await (
      await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
    ).json();
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
      if (p) {
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');

    console.log('设备\t\t视口宽\t横向溢出\t内容宽\t可视组件');
    console.log('─'.repeat(72));

    for (const d of DEVICES) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: d.w,
        height: d.h,
        deviceScaleFactor: 1,
        mobile: d.w < 768,
      });
      await send('Page.navigate', { url: TARGET });
      await sleep(2600);
      // 首页是书架，先点第一本进入写作台，否则量不到编辑器布局
      await evaluate(`(() => {
        const card = document.querySelector('.shelf .lib-card');
        if (card) card.click();
        return !!card;
      })()`);
      await sleep(1600);

      const info = await evaluate(`(() => {
        const doc = document.documentElement;
        const body = document.body;
        // 找出实际最宽的布局块
        const sidebar = document.querySelector('.sidebar');
        const rightbar = document.querySelector('.rightbar');
        const editor = document.querySelector('.editor-inner');
        return {
          viewport: window.innerWidth,
          overflow: Math.max(doc.scrollWidth, body.scrollWidth) > window.innerWidth + 2,
          contentWidth: Math.max(doc.scrollWidth, body.scrollWidth),
          sidebarW: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
          rightbarW: rightbar ? Math.round(rightbar.getBoundingClientRect().width) : 0,
          editorW: editor ? Math.round(editor.getBoundingClientRect().width) : 0,
          // 右侧栏是否被挤出可视区
          rightbarVisible: rightbar ? rightbar.getBoundingClientRect().left < window.innerWidth : null,
        };
      })()`);

      const overflowMark = info.overflow ? `是 (${info.contentWidth}px)` : '否';
      const parts = `侧栏${info.sidebarW} 编辑${info.editorW} 右栏${info.rightbarW}${info.rightbarVisible === false ? ' [右栏在屏幕外!]' : ''}`;
      console.log(`${d.name.padEnd(12)}\t${String(info.viewport).padEnd(6)}\t${overflowMark.padEnd(12)}\t${info.contentWidth}\t${parts}`);
    }

    ws.close();
  } finally {
    child.kill();
  }
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exitCode = 1;
});
