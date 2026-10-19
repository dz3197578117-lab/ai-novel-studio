/**
 * 端到端验证「AI 写作」完整交互：
 * 配置 mock 模型 → 打开章节 → 点生成 → 确认流式文本出现 → 追加到正文。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9444;
const API = process.env.API_BASE ?? 'http://127.0.0.1:8789';
const UI = process.env.UI_BASE ?? 'http://127.0.0.1:5173';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  // 1. 先把 mock 模型配好
  const put = await fetch(`${API}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: {
        baseUrl: 'http://127.0.0.1:8899/v1',
        apiKey: 'mock-key',
        model: 'mock-model',
        temperature: 0.8,
        maxTokens: 2048,
      },
    }),
  });
  check('写入 mock 模型配置', put.ok, `HTTP ${put.status}`);

  const projects = await (await fetch(`${API}/api/projects`)).json();
  const project = projects.find((p) => p.title === '长夜行') ?? projects[0];
  check('找到演示项目', Boolean(project), project?.title);

  const profile = path.join(os.tmpdir(), `nf-write-${Date.now()}`);
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
    // 等 DevTools
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

    let msgId = 0;
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
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
      }
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: UI });
    await sleep(4000);

    check('页面已加载', (await evaluate('document.getElementById("root").innerHTML.length')) > 500);

    // 首页是书架，先点第一本进入写作台
    await evaluate(`(() => {
      const card = document.querySelector('.shelf .lib-card');
      if (card) card.click();
      return !!card;
    })()`);
    await sleep(2200);

    // 2. 选中一个有正文的章节（第一章）
    await evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.chapter-item'));
      const t = items.find(e => e.textContent.includes('雪落祠堂'));
      if (t) t.click();
      return !!t;
    })()`);
    await sleep(1200);

    const beforeLen = await evaluate('document.querySelector("textarea.fiction")?.value.length ?? 0');
    check('章节正文已加载', beforeLen > 50, `${beforeLen} 字`);

    // 3. 记录正文初始内容
    const beforeContent = await evaluate('document.querySelector("textarea.fiction").value');

    // 4. 点击「生成」
    const clicked = await evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '生成');
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    check('点击生成按钮', clicked);

    // 5. 等待流式结果出现（mock 每 60ms 一段）
    let resultText = '';
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      resultText = await evaluate(
        'document.querySelector(".result-box")?.textContent?.trim() ?? ""',
      );
      if (resultText.includes('柴是有的')) break;
    }
    check('流式生成结果已渲染', resultText.length > 10, `${resultText.length} 字: ${resultText.slice(0, 40)}`);

    // 6. 点击「追加到末尾」
    const applied = await evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('追加到末尾'));
      if (btn && !btn.disabled) { btn.click(); return true; }
      return false;
    })()`);
    check('追加到末尾按钮可点击', applied);

    await sleep(2500); // 等自动保存
    const afterContent = await evaluate('document.querySelector("textarea.fiction").value');
    check(
      '生成文本已写入正文',
      afterContent.length > beforeContent.length && afterContent.includes('外院的屋子'),
      `${beforeContent.length} → ${afterContent.length} 字`,
    );

    // 7. 等待自动保存落库
    await sleep(2000);
    const chapters = await (await fetch(`${API}/api/projects/${project.id}/chapters`)).json();
    const first = chapters.find((c) => c.title.includes('雪落祠堂'));
    const detail = await (await fetch(`${API}/api/chapters/${first.id}`)).json();
    check(
      '自动保存已写入数据库',
      detail.content.includes('外院的屋子'),
      `库中 ${detail.wordCount} 字`,
    );

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
