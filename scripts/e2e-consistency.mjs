/**
 * 设定中心（一致性引擎）端到端测试：
 * 打开面板 → 添加伏笔 → 标记回收 → 添加时间线 → 跑一致性检查 → 看到问题卡片。
 *
 * 用临时作品，结束后删除并还原设置。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9555;
const MOCK_PORT = 8899;
const UI = process.env.UI_BASE ?? 'http://127.0.0.1:5173/';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const TMP_TITLE = '一致性E2E临时书';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function apiJson(pathname, init) {
  const res = await fetch(`${API}${pathname}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function dumpSettings() {
  const db = new DatabaseSync('apps/server/data/novelforge.db');
  const rows = db.prepare('SELECT key, value FROM settings').all();
  db.close();
  return rows;
}
function restoreSettings(rows) {
  const db = new DatabaseSync('apps/server/data/novelforge.db');
  db.exec('DELETE FROM settings');
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const r of rows) stmt.run(r.key, r.value);
  db.close();
}

async function ensureMock() {
  try {
    await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
    return null;
  } catch {
    /* 需要启动 */
  }
  const child = spawn('node', ['scripts/mock-llm.mjs', String(MOCK_PORT)], {
    stdio: 'ignore',
    detached: false,
  });
  await sleep(1500);
  return child;
}

async function main() {
  const originalSettings = dumpSettings();
  const mock = await ensureMock();
  let projectId = null;

  try {
    const created = await apiJson('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'E2E Mock',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        apiKey: 'mock-key',
        model: 'mock-model',
      }),
    });
    await apiJson(`/api/profiles/${created.id}/activate`, { method: 'POST' });

    // 准备一个临时作品（1 章 1 设定，避免动用户数据）
    const proj = await apiJson('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: TMP_TITLE, logline: '用于测试一致性引擎' }),
    });
    projectId = proj.id;
    await apiJson(`/api/projects/${proj.id}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '第一章 · 开端', outline: '主角登场' }),
    });
    await apiJson(`/api/projects/${proj.id}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'character', name: '林尘', summary: '沉默寡言的主角' }),
    });

    const profile = path.join(os.tmpdir(), `nf-cons-${Date.now()}`);
    const child = spawn(
      EDGE,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--window-size=1500,1000',
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
      const clickText = (text, root = '') =>
        evaluate(`(() => {
          const b = Array.from(document.querySelectorAll('${root}button')).find(x => x.textContent.trim().includes(${JSON.stringify(text)}));
          if (b && !b.disabled) { b.click(); return true; }
          return false;
        })()`);
      const fillInput = (placeholder, value) =>
        evaluate(`(() => {
          const el = Array.from(document.querySelectorAll('.modal input')).find(i => (i.placeholder || '').includes(${JSON.stringify(placeholder)}));
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.navigate', { url: UI });
      await sleep(4200);

      // 进入临时作品
      await evaluate(`(() => {
        const card = Array.from(document.querySelectorAll('.shelf .lib-card')).find(c => c.textContent.includes(${JSON.stringify(TMP_TITLE)}));
        if (card) card.click();
        return !!card;
      })()`);
      await sleep(2200);

      // 打开设定中心
      check('顶栏有「设定中心」', await clickText('设定中心'));
      await sleep(900);
      const title = await evaluate('document.querySelector(".modal h2")?.textContent ?? ""');
      check('设定中心已打开', title.includes('设定中心'), title);

      // ── 伏笔 ──
      check('填写伏笔标题', await fillInput('如：父亲临终前提到的', '北境的塔'));
      check('添加伏笔', await clickText('添加伏笔'));
      await sleep(1200);
      const fsTexts = await evaluate(
        'Array.from(document.querySelectorAll(".profile-row")).map(e=>e.textContent).join("|")',
      );
      check('伏笔出现在列表', fsTexts.includes('北境的塔'));
      check('伏笔默认未回收', fsTexts.includes('未回收'));

      check('标记已回收', await clickText('标记已回收'));
      await sleep(1200);
      const fsAfter = await evaluate(
        'Array.from(document.querySelectorAll(".profile-row")).map(e=>e.textContent).join("|")',
      );
      check('状态变为已回收', fsAfter.includes('已回收'));

      // ── 时间线 ──
      check('切到时间线', await clickText('时间线'));
      await sleep(500);
      check('填写事件', await fillInput('如：林尘夺得试剑第一', '试剑夺魁'));
      check('添加事件', await clickText('添加事件'));
      await sleep(1000);
      const tlTexts = await evaluate(
        'Array.from(document.querySelectorAll(".profile-row")).map(e=>e.textContent).join("|")',
      );
      check('时间线事件出现', tlTexts.includes('试剑夺魁'));

      // ── 一致性检查 ──
      check('切到一致性检查', await clickText('一致性检查'));
      await sleep(600);
      check('点击开始检查', await clickText('开始检查'));

      let issues = 0;
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        issues = await evaluate('document.querySelectorAll(".issue-card").length');
        if (issues > 0) break;
      }
      check('检查返回问题列表', issues >= 1, `${issues} 个问题`);

      const issueText = await evaluate(
        'Array.from(document.querySelectorAll(".issue-card")).map(e=>e.textContent).join("|")',
      );
      check('问题包含类型与建议', issueText.includes('人物') && issueText.includes('建议'), issueText.slice(0, 60));
      check('严重程度有标注', issueText.includes('严重'));

      // 数据落库
      const fs = await apiJson(`/api/projects/${projectId}/foreshadows`);
      check('伏笔已落库且状态正确', fs.length === 1 && fs[0].status === 'recovered', fs[0]?.status);
      const tl = await apiJson(`/api/projects/${projectId}/timeline`);
      check('时间线已落库', tl.length === 1, `${tl.length} 条`);

      ws.close();
    } finally {
      child.kill();
    }
  } finally {
    if (projectId) {
      await fetch(`${API}/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});
    }
    restoreSettings(originalSettings);
    if (mock) mock.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exitCode = 1;
});
