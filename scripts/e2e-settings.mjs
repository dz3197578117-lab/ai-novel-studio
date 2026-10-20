/**
 * 「多套模型配置」端到端测试：
 * 添加配置 → 拉取模型列表 → 保存 → 设为当前 → 删除 → 当前自动回退。
 *
 * 会临时指向本地 mock 服务，结束后还原 settings 表。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const MOCK_PORT = 8899;
const UI = process.env.UI_BASE ?? 'http://127.0.0.1:5173/';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';

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

  try {
    const profile = path.join(os.tmpdir(), `nf-set-${Date.now()}`);
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
      /** 按 placeholder 填输入框 */
      const fill = (placeholderPart, value) =>
        evaluate(`(() => {
          const el = Array.from(document.querySelectorAll('.modal input')).find(i => (i.placeholder || '').includes(${JSON.stringify(placeholderPart)}));
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
      const clickText = (text) =>
        evaluate(`(() => {
          const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.trim().includes(${JSON.stringify(text)}));
          if (b && !b.disabled) { b.click(); return true; }
          return false;
        })()`);

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.navigate', { url: UI });
      await sleep(4200);

      // 1. 打开设置
      await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('设置'));
        if (b) b.click();
        return !!b;
      })()`);
      await sleep(900);
      const dialogTitle = await evaluate('document.querySelector(".modal h2")?.textContent ?? ""');
      check('设置弹窗已打开', dialogTitle.includes('设置'), dialogTitle);

      const initialRows = await evaluate('document.querySelectorAll(".profile-row").length');
      check('默认带出一个配置', initialRows >= 1, `${initialRows} 条`);

      // 2. 新增配置
      check('点击「＋ 添加」', await clickText('添加'));
      await sleep(600);

      await fill('如：DeepSeek 官方', '本地 Mock');
      await fill('https://api.deepseek.com/v1', `http://127.0.0.1:${MOCK_PORT}/v1`);
      await fill('sk-…', 'mock-key-for-test');
      await sleep(300);

      // 3. 拉取模型列表
      check('点击「拉取模型」', await clickText('拉取模型'));
      let modelOptions = 0;
      for (let i = 0; i < 25; i++) {
        await sleep(300);
        modelOptions = await evaluate('document.querySelectorAll(".modal select option").length');
        if (modelOptions > 0) break;
      }
      check('拉取到可选模型并变成下拉', modelOptions >= 3, `${modelOptions} 个选项`);

      const selectedModel = await evaluate(`(() => {
        const sel = document.querySelector('.modal select');
        if (!sel) return '';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, 'mock-model');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return sel.value;
      })()`);
      check('可选择模型', selectedModel === 'mock-model', selectedModel);

      // 4. 保存
      check('点击「保存配置」', await clickText('保存配置'));
      await sleep(1500);
      const rowsAfterAdd = await evaluate(
        'Array.from(document.querySelectorAll(".profile-row")).map(e=>e.textContent).join("|")',
      );
      check('新配置出现在列表', rowsAfterAdd.includes('本地 Mock'), `${rowsAfterAdd.slice(0, 80)}`);

      // 5. 设为当前
      const setActive = await evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('.profile-row')).find(r => r.textContent.includes('本地 Mock'));
        if (!row) return false;
        const b = Array.from(row.querySelectorAll('button')).find(x => x.textContent.includes('设为当前'));
        if (b && !b.disabled) { b.click(); return true; }
        return false;
      })()`);
      check('点击「设为当前」', setActive);
      await sleep(1200);

      let settingsState = await apiJson('/api/settings');
      const activeName = settingsState.profiles.find(
        (p) => p.id === settingsState.activeProfileId,
      )?.name;
      check('当前配置已切换', activeName === '本地 Mock', activeName);

      // 6. 测试当前配置
      check('点击「测试当前配置」', await clickText('测试当前配置'));
      let testMsg = '';
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        testMsg = await evaluate(
          'Array.from(document.querySelectorAll(".modal div")).map(d=>d.textContent||"").find(t=>t.includes("连接成功")) ?? ""',
        );
        if (testMsg) break;
      }
      check('当前配置可连通', testMsg.includes('连接成功'), testMsg.slice(0, 60));

      // 7. 删除其它配置：先点一次 UI 验证删除路径，再把剩下的用 API 清掉
      //    （环境里可能有多套配置，不能假设只有两套；测试结束会整体还原 settings）
      const deleted = await evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('.profile-row')).find(r => !r.textContent.includes('本地 Mock'));
        if (!row) return false;
        const b = Array.from(row.querySelectorAll('button')).find(x => x.textContent.trim() === '删除');
        if (!b) return false;
        window.confirm = () => true;
        b.click();
        return true;
      })()`);
      check('点击删除其它配置', deleted);
      await sleep(1500);

      const mid = await apiJson('/api/settings');
      for (const prof of mid.profiles) {
        if (prof.name !== '本地 Mock') {
          await apiJson(`/api/profiles/${prof.id}`, { method: 'DELETE' });
        }
      }

      settingsState = await apiJson('/api/settings');
      check('删除后只剩一个配置', settingsState.profiles.length === 1, `${settingsState.profiles.length} 条`);
      check(
        '当前配置仍有效',
        settingsState.profiles[0]?.id === settingsState.activeProfileId &&
          settingsState.profiles[0]?.name === '本地 Mock',
        `${settingsState.profiles[0]?.name} / active=${settingsState.activeProfileId}`,
      );

      // 8. 关闭弹窗，回到书架
      await evaluate(
        'document.querySelector(".modal-backdrop")?.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))',
      );
      await sleep(800);
      check('关闭设置后回到书架', (await evaluate('!!document.querySelector(".shelf")')) === true);

      ws.close();
    } finally {
      child.kill();
    }
  } finally {
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
