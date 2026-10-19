/**
 * 用 Chrome DevTools Protocol 驱动无头浏览器做端到端 UI 验证。
 * 不依赖任何 npm 包，只用 Node 内置 WebSocket + fetch。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = process.env.TARGET_URL ?? 'http://127.0.0.1:8799/';
const PORT = 9333;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('DevTools 未就绪');
}

async function openPage() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  if (!res.ok) throw new Error(`打开页面失败 ${res.status}`);
  return await res.json();
}

class CDP {
  constructor(wsUrl) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'JS 执行异常');
    }
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const profile = path.join(os.tmpdir(), `nf-e2e-${Date.now()}`);
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--window-size=1600,950',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  try {
    await waitForDevtools();
    const page = await openPage();
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 收集 console 错误
    const errors = [];
    cdp.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails?.exception?.description ?? 'unknown');
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });

    await cdp.send('Page.navigate', { url: URL });
    await sleep(3500);

    // 1. React 是否挂载
    const rootHtmlLen = await cdp.eval('document.getElementById("root").innerHTML.length');
    check('React 已挂载', rootHtmlLen > 500, `root innerHTML ${rootHtmlLen} 字符`);

    // 2. 首页是书架，不是编辑器
    const shelfVisible = await cdp.eval('!!document.querySelector(".shelf")');
    check('首页显示书架', shelfVisible === true);
    const shelfCards = await cdp.eval('document.querySelectorAll(".shelf .lib-card").length');
    check('书架上有作品卡片', shelfCards >= 1, `${shelfCards} 本`);
    const editorOnShelf = await cdp.eval('!!document.querySelector(".editor-body")');
    check('书架上不显示编辑器', editorOnShelf === false);

    // 3. 点书进入写作台
    const entered = await cdp.eval(`(() => {
      const card = document.querySelector('.shelf .lib-card');
      if (!card) return false;
      card.click();
      return true;
    })()`);
    check('点击作品进入写作台', entered);
    await sleep(2200);
    const inWorkspace = await cdp.eval('!!document.querySelector(".editor-body")');
    check('写作台已打开', inWorkspace === true);

    // 4. 品牌与目录渲染
    const brand = await cdp.eval('document.querySelector(".sidebar .brand")?.textContent ?? ""');
    check('侧边栏品牌渲染', brand.includes('NovelForge'), brand.trim());

    const projectOptions = await cdp.eval(
      'Array.from(document.querySelectorAll("select option")).map(o=>o.textContent).join("|")',
    );
    check('演示作品已加载', projectOptions.includes('长夜行'), projectOptions);

    const chapterTitles = await cdp.eval(
      'Array.from(document.querySelectorAll(".chapter-item")).map(e=>e.textContent).join("|")',
    );
    check('章节树渲染', chapterTitles.includes('雪落祠堂'), chapterTitles.slice(0, 120));

    const volumeLabels = await cdp.eval(
      'Array.from(document.querySelectorAll(".volume-label")).map(e=>e.textContent).join("|")',
    );
    check('卷分组渲染', volumeLabels.includes('第一卷'), volumeLabels);

    // 3. 编辑器加载首章正文
    const content = await cdp.eval('document.querySelector("textarea.fiction")?.value ?? ""');
    check('首章正文载入编辑器', content.includes('雪落了三日'), `${content.length} 字`);

    // 4. AI 面板
    const tabs = await cdp.eval(
      'Array.from(document.querySelectorAll(".ai-tabs button")).map(b=>b.textContent).join(",")',
    );
    check('AI 模式标签', ['续写', '改写', '润色', '扩写', '仿写'].every((t) => tabs.includes(t)), tabs);

    // 5. 交互：切换到第二章
    await cdp.eval(`(() => {
      const items = Array.from(document.querySelectorAll('.chapter-item'));
      const target = items.find(e => e.textContent.includes('断剑'));
      if (target) target.click();
      return !!target;
    })()`);
    await sleep(900);
    const titleAfter = await cdp.eval('document.querySelector("input.title")?.value ?? ""');
    check('切换章节生效', titleAfter.includes('断剑'), titleAfter);

    // 6. 打开设定库弹窗
    await cdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => x.textContent.includes('设定库'));
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(800);
    const modalTitle = await cdp.eval('document.querySelector(".modal h2")?.textContent ?? ""');
    const entityCount = await cdp.eval('document.querySelectorAll(".entity-card").length');
    check('设定库弹窗打开', modalTitle.includes('设定库'), modalTitle);
    check('设定条目渲染', entityCount >= 5, `${entityCount} 条`);

    // 关闭弹窗
    await cdp.eval('document.querySelector(".modal-backdrop")?.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
    await sleep(400);

    // 7. 打开导出弹窗
    await cdp.eval(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('导出'));
      if (b) b.click(); return !!b;
    })()`);
    await sleep(700);
    const exportTitle = await cdp.eval('document.querySelector(".modal h2")?.textContent ?? ""');
    check('导出弹窗打开', exportTitle.includes('导出'), exportTitle);

    // 8. 页面无 JS 异常
    check('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

    // 关掉弹窗，再测「返回书架」
    await cdp.eval('document.querySelector(".modal-backdrop")?.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
    await sleep(500);

    const backBtn = await cdp.eval(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('书架'));
      if (b) { b.click(); return true; }
      return false;
    })()`);
    check('点击「← 书架」', backBtn);
    await sleep(1200);
    const backOnShelf = await cdp.eval('!!document.querySelector(".shelf")');
    const editorGone = await cdp.eval('!!document.querySelector(".editor-body")');
    check('已返回书架', backOnShelf === true && editorGone === false);

    // 截图存档
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve('e2e-shelf.png'), Buffer.from(shot.data, 'base64'));

    cdp.close();
  } finally {
    child.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('E2E 失败:', e.message);
  process.exitCode = 1;
});
