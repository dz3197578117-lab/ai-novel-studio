/**
 * 诊断/验证编辑器滚动：派发真实滚轮事件，检查 scrollTop 是否变化。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9667;
const UI = process.env.UI_BASE ?? 'http://127.0.0.1:5173/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = path.join(os.tmpdir(), `nf-scroll2-${Date.now()}`);
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=1400,900',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

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
    await send('Page.navigate', { url: UI });
    await sleep(4200);

    const probe = `(() => {
      const ta = document.querySelector('textarea.fiction');
      if (!ta) return { error: '无编辑器' };
      const cs = getComputedStyle(ta);
      const r = ta.getBoundingClientRect();
      return {
        chars: ta.value.length,
        clientH: ta.clientHeight,
        scrollH: ta.scrollHeight,
        scrollTop: ta.scrollTop,
        overflowY: cs.overflowY,
        scrollable: ta.scrollHeight > ta.clientHeight + 2,
        centerX: r.left + r.width / 2,
        centerY: r.top + Math.min(200, r.height / 2),
      };
    })()`;

    // ── 场景 1：打开第一章（程序赋值）──
    // 先记下原始正文，收尾时还原，避免测试数据污染演示作品
    const originalContent = await evaluate('document.querySelector("textarea.fiction").value');
    const a = await evaluate(probe);
    check('正文区可滚动（内容高于可视区）', a.scrollable === true, `${a.clientH}px 可视 / ${a.scrollH}px 内容`);

    // 派发真实滚轮事件
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: a.centerX,
      y: a.centerY,
      deltaX: 0,
      deltaY: 320,
      pointerType: 'mouse',
    });
    await sleep(600);
    const afterWheel = await evaluate('document.querySelector("textarea.fiction").scrollTop');
    check('滚轮向下滚动生效', afterWheel > 0, `scrollTop ${a.scrollTop} → ${afterWheel}`);

    // 向上滚回
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: a.centerX,
      y: a.centerY,
      deltaX: 0,
      deltaY: -200,
      pointerType: 'mouse',
    });
    await sleep(500);
    const afterUp = await evaluate('document.querySelector("textarea.fiction").scrollTop');
    check('滚轮向上滚动生效', afterUp < afterWheel, `scrollTop ${afterWheel} → ${afterUp}`);

    // ── 场景 2：切到另一章应回到顶部 ──
    // 注意：必须切到「不同」的章节，点当前章不会触发章节切换
    await evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.chapter-item'));
      const t = items.find(e => e.textContent.includes('断剑'));
      if (t) t.click(); return !!t;
    })()`);
    await sleep(1000);
    const switched = await evaluate('document.querySelector("textarea.fiction")?.scrollTop ?? -1');
    check('切到另一章后回到顶部', switched === 0, `scrollTop=${switched}`);

    // 再切回有正文的章节，确认仍可滚动
    await evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.chapter-item'));
      const t = items.find(e => e.textContent.includes('雪落祠堂'));
      if (t) t.click(); return !!t;
    })()`);
    await sleep(1000);
    const b = await evaluate(probe);
    check('切回后仍回到顶部', b.scrollTop === 0, `scrollTop=${b.scrollTop}`);
    check('切章后内容完整可达', b.scrollable === true, `${b.clientH}px 可视 / ${b.scrollH}px 内容`);

    // ── 场景 3：超长正文 ──
    await evaluate(`(() => {
      const ta = document.querySelector('textarea.fiction');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '这是一段用于测试滚动的正文内容。'.repeat(600));
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(700);
    const c = await evaluate(probe);
    check('超长正文可滚动', c.scrollable === true, `${c.clientH}px 可视 / ${c.scrollH}px 内容`);

    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: c.centerX,
      y: c.centerY,
      deltaX: 0,
      deltaY: 500,
      pointerType: 'mouse',
    });
    await sleep(600);
    const longScroll = await evaluate('document.querySelector("textarea.fiction").scrollTop');
    check('超长正文滚轮生效', longScroll > 0, `scrollTop=${longScroll}`);

    // ── 场景 4：编辑器高度未撑破布局 ──
    const layout = await evaluate(`(() => {
      const body = document.querySelector('.editor-body');
      const ta = document.querySelector('textarea.fiction');
      return {
        bodyScrollable: body.scrollHeight > body.clientHeight + 2,
        bodyH: body.clientHeight,
        taH: ta.clientHeight,
        viewportOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      };
    })()`);
    check('外层容器不再溢出滚动', layout.bodyScrollable === false, `body ${layout.bodyH}px, textarea ${layout.taH}px`);
    check('页面无横向溢出', layout.viewportOverflow === false);

    // ── 收尾：把正文还原，避免测试数据被自动保存进数据库 ──
    await evaluate(`(() => {
      const ta = document.querySelector('textarea.fiction');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(originalContent)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(2200); // 等自动保存(1.2s 防抖)落库
    const restored = await evaluate('document.querySelector("textarea.fiction").value');
    check('测试数据已还原', restored === originalContent, `${restored.length} 字`);

    ws.close();
  } finally {
    child.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exitCode = 1;
});
