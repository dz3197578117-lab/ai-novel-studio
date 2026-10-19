/**
 * 作品库（小说管理）端到端测试。
 * 会创建一个临时作品，验证列表 / 搜索 / 删除，结束后自动清理。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9777;
const UI = process.env.UI_BASE ?? 'http://127.0.0.1:5173/';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const TEMP_TITLE = '临时测试作品';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function apiJson(pathname, init) {
  const res = await fetch(`${API}${pathname}`, init);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`);
  return res.json();
}

async function main() {
  // 准备：创建一个临时作品
  const temp = await apiJson('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: TEMP_TITLE, genre: '测试', logline: '这条记录用于验证作品库删除功能' }),
  });

  const overview = await apiJson('/api/projects/overview');
  check('概览接口返回作品列表', Array.isArray(overview) && overview.length >= 2, `${overview.length} 部`);

  const profile = path.join(os.tmpdir(), `nf-lib-${Date.now()}`);
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

    // 1. 打开作品库
    const opened = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('作品库'));
      if (b) b.click();
      return !!b;
    })()`);
    check('顶栏有「作品库」入口', opened);
    await sleep(900);

    const modalTitle = await evaluate('document.querySelector(".modal h2")?.textContent ?? ""');
    check('作品库已打开', modalTitle.includes('作品库'), modalTitle);

    // 2. 卡片与统计
    const cardCount = await evaluate('document.querySelectorAll(".lib-card").length');
    check('作品卡片渲染', cardCount >= 2, `${cardCount} 张`);

    const cardTexts = await evaluate(
      'Array.from(document.querySelectorAll(".lib-card")).map(e=>e.textContent).join("|")',
    );
    check('卡片显示统计信息', /章/.test(cardTexts) && /字/.test(cardTexts), cardTexts.slice(0, 80));
    check('临时作品出现在列表', cardTexts.includes(TEMP_TITLE));

    // 3. 搜索过滤
    await evaluate(`(() => {
      const input = document.querySelector('.modal input[placeholder*="搜索"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '临时测试');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const filtered = await evaluate('document.querySelectorAll(".lib-card").length');
    check('搜索可过滤', filtered === 1, `过滤后 ${filtered} 张`);

    // 4. 清空搜索
    await evaluate(`(() => {
      const input = document.querySelector('.modal input[placeholder*="搜索"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);

    // 5. 删除临时作品（自动确认 confirm）
    await evaluate('window.confirm = () => true');
    const clickedDelete = await evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('.lib-card'));
      const card = cards.find(c => c.textContent.includes('${TEMP_TITLE}'));
      if (!card) return false;
      const btn = Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '删除');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    check('点击删除按钮', clickedDelete);
    await sleep(1600);

    const afterDelete = await evaluate(
      'Array.from(document.querySelectorAll(".lib-card")).map(e=>e.textContent).join("|")',
    );
    check('删除后卡片消失', !afterDelete.includes(TEMP_TITLE));

    const gone = await fetch(`${API}/api/projects/${temp.id}`);
    check('数据库中已删除', gone.status === 404, `HTTP ${gone.status}`);

    // 6. 新建入口存在
    const hasCreate = await evaluate(
      `Array.from(document.querySelectorAll('.modal button')).some(b => b.textContent.includes('新建'))`,
    );
    check('作品库内有「新建」入口', hasCreate);

    // 7. 关闭后主界面仍有当前作品
    await evaluate('document.querySelector(".modal-backdrop")?.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
    await sleep(600);
    const stillHasProject = await evaluate(
      'document.querySelectorAll(".chapter-item").length > 0',
    );
    check('关闭作品库后写作界面正常', stillHasProject);

    ws.close();
  } finally {
    child.kill();
    // 兜底清理临时作品
    await fetch(`${API}/api/projects/${temp.id}`, { method: 'DELETE' }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exitCode = 1;
});
