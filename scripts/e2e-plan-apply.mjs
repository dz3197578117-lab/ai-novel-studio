/**
 * 回归测试：AI 整改结果必须写回「发起整改的那一章」。
 *
 * 场景：对第 1 章发起整改 → 结果出来后切到第 2 章 → 点「应用」。
 * 期望：第 1 章大纲被改，第 2 章保持原样。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9444;
const MOCK_PORT = 8899;
const UI = process.env.UI_BASE ?? 'http://127.0.0.1:5173/';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const TMP_TITLE = '整改跨章测试';

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
    const prof = await apiJson('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'E2E Mock',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        apiKey: 'mock-key',
        model: 'mock-model',
      }),
    });
    await apiJson(`/api/profiles/${prof.id}/activate`, { method: 'POST' });

    // 临时项目：两章，各自有可辨认的大纲
    const proj = await apiJson('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: TMP_TITLE }),
    });
    projectId = proj.id;
    const ch1 = await apiJson(`/api/projects/${proj.id}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '第1章 · 甲', outline: '第一章原始大纲：主角醒来。' }),
    });
    const ch2 = await apiJson(`/api/projects/${proj.id}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '第2章 · 乙', outline: '第二章原始大纲：主角出门。' }),
    });

    const profile = path.join(os.tmpdir(), `nf-planapply-${Date.now()}`);
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
          if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
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
      const clickText = (text) =>
        evaluate(`(() => {
          const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim().includes(${JSON.stringify(text)}));
          if (b && !b.disabled) { b.click(); return true; }
          return false;
        })()`);

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.navigate', { url: UI });
      await sleep(4200);

      check(
        '打开临时作品',
        await evaluate(`(() => {
          const card = Array.from(document.querySelectorAll('.shelf .lib-card')).find(c => c.textContent.includes(${JSON.stringify(TMP_TITLE)}));
          if (card) { card.click(); return true; }
          return false;
        })()`),
      );
      await sleep(2200);

      // 选中第 1 章
      check(
        '选中第 1 章',
        await evaluate(`(() => {
          const t = Array.from(document.querySelectorAll('.chapter-item')).find(e => e.textContent.includes('第1章'));
          if (t) { t.click(); return true; }
          return false;
        })()`),
      );
      await sleep(1200);

      // 展开规划区
      check(
        '展开规划区',
        await evaluate(`(() => {
          const b = Array.from(document.querySelectorAll('.prep button')).find(x => x.textContent.trim() === '展开');
          if (b) { b.click(); return true; }
          return false;
        })()`),
      );
      await sleep(600);

      // 输入整改指令并发起整改
      const typed = await evaluate(`(() => {
        const el = Array.from(document.querySelectorAll('.plan-input input'))[0];
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '把结尾改成反转');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      check('输入整改指令', typed);
      // 注意：页面上还有「AI 自查整改」按钮，必须精确点 .plan-input 里的「整改」
      const clickedRevise = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('.plan-input button')).find(x => x.textContent.trim() === '整改');
        if (b && !b.disabled) { b.click(); return true; }
        return false;
      })()`);
      check('点击整改', clickedRevise);

      let hasResult = false;
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        hasResult = await evaluate(`(() => {
          const head = document.querySelector('.plan-result .plan-result-head')?.textContent ?? '';
          return head.includes('整改后');
        })()`);
        if (hasResult) break;
      }
      check('整改结果出现', hasResult);

      // 关键动作：切到第 2 章，再点「应用」
      check(
        '切到第 2 章',
        await evaluate(`(() => {
          const t = Array.from(document.querySelectorAll('.chapter-item')).find(e => e.textContent.includes('第2章'));
          if (t) { t.click(); return true; }
          return false;
        })()`),
      );
      await sleep(1200);
      check('点击应用', await clickText('应用'));
      await sleep(2000);

      const after1 = await apiJson(`/api/chapters/${ch1.id}`);
      const after2 = await apiJson(`/api/chapters/${ch2.id}`);
      check(
        '第 1 章大纲已更新',
        after1.outline.includes('校招会'),
        after1.outline.slice(0, 40),
      );
      check(
        '第 2 章大纲未被覆盖',
        after2.outline === '第二章原始大纲：主角出门。',
        after2.outline.slice(0, 40),
      );
      check(
        '编辑器未把结果塞进当前章',
        (await evaluate('document.querySelector("textarea.fiction")?.value ?? ""')) === '',
      );

      // ── 同章应用：仍停留在第 2 章，整改后直接应用应写进第 2 章 ──
      await evaluate(`(() => {
        const el = Array.from(document.querySelectorAll('.plan-input input'))[0];
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '再把开头改得更紧');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('.plan-input button')).find(x => x.textContent.trim() === '整改');
        if (b && !b.disabled) { b.click(); return true; }
        return false;
      })()`);
      let sameResult = false;
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        sameResult = await evaluate(
          `(document.querySelector('.plan-result .plan-result-head')?.textContent ?? '').includes('整改后')`,
        );
        if (sameResult) break;
      }
      check('同章整改结果出现', sameResult);
      check(
        '点击应用（同章）',
        await evaluate(`(() => {
          const b = Array.from(document.querySelectorAll('.plan-result button')).find(x => x.textContent.trim() === '应用');
          if (b && !b.disabled) { b.click(); return true; }
          return false;
        })()`),
      );
      await sleep(2500);
      const sameCh2 = await apiJson(`/api/chapters/${ch2.id}`);
      check('同章应用写进第 2 章', sameCh2.outline.includes('校招会'), sameCh2.outline.slice(0, 30));

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
