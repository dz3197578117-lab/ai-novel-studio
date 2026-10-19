/**
 * 「AI 生成小说」端到端测试：
 * 书架上打开对话框 → 填需求 → 生成方案 → 预览 → 创建作品 → 进入写作台。
 *
 * 会临时把模型配置指向本地 mock，结束后还原设置并删除测试作品。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9222;
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

/** 备份 / 还原 settings 表 */
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
    return null; // 已在运行
  } catch {
    /* 需要自己启动 */
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
  let createdProjectId = null;

  try {
    // 把模型指向 mock
    await apiJson('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: {
          baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
          apiKey: 'mock-key',
          model: 'mock-model',
          temperature: 0.8,
          maxTokens: 4096,
        },
      }),
    });

    const profile = path.join(os.tmpdir(), `nf-draft-${Date.now()}`);
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

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.navigate', { url: UI });
      await sleep(4200);

      // 1. 书架上能打开对话框
      const opened = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('AI 生成小说'));
        if (b) { b.click(); return true; }
        return false;
      })()`);
      check('书架上存在「AI 生成小说」入口', opened);
      await sleep(800);
      const title = await evaluate('document.querySelector(".modal h2")?.textContent ?? ""');
      check('对话框已打开', title.includes('AI 生成小说'), title);

      // 2. 填写需求并生成
      await evaluate(`(() => {
        const ta = document.querySelector('.modal textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '一个被逐出宗门的剑修，追查父亲失踪真相，想写冷峻克制的古典玄幻');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(300);

      const clickedGenerate = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.includes('生成方案'));
        if (b && !b.disabled) { b.click(); return true; }
        return false;
      })()`);
      check('点击「生成方案」', clickedGenerate);

      // 3. 等待方案预览出现
      let draftTitle = '';
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        draftTitle = await evaluate('document.querySelector(".draft-title")?.textContent ?? ""');
        if (draftTitle) break;
      }
      check('生成出小说方案', Boolean(draftTitle), draftTitle);

      const chaptersRendered = await evaluate('document.querySelectorAll(".draft-chapter").length');
      check('预览包含章节大纲', chaptersRendered >= 3, `${chaptersRendered} 章`);
      const entitiesRendered = await evaluate('document.querySelectorAll(".draft-entity").length');
      check('预览包含设定条目', entitiesRendered >= 3, `${entitiesRendered} 条`);
      const volumesRendered = await evaluate('document.querySelectorAll(".draft-volume").length');
      check('预览按卷分组', volumesRendered >= 1, `${volumesRendered} 卷`);
      const logline = await evaluate('document.querySelector(".draft-logline")?.textContent ?? ""');
      check('预览显示简介', logline.length > 5, logline.slice(0, 40));

      // 4. 创建作品
      const clickedCreate = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.includes('创建这本书'));
        if (b && !b.disabled) { b.click(); return true; }
        return false;
      })()`);
      check('点击「创建这本书」', clickedCreate);

      // 5. 创建后应进入写作台
      let inWorkspace = false;
      for (let i = 0; i < 25; i++) {
        await sleep(400);
        inWorkspace = await evaluate('!!document.querySelector(".editor-body")');
        if (inWorkspace) break;
      }
      check('创建后进入写作台', inWorkspace === true);

      const chapterCount = await evaluate('document.querySelectorAll(".chapter-item").length');
      check('新作品带入了章节', chapterCount >= 3, `${chapterCount} 章`);

      const titleInput = await evaluate('document.querySelector("input.title")?.value ?? ""');
      check('编辑器打开的是新书章节', Boolean(titleInput), titleInput);

      // 6. 数据落库校验
      const projects = await apiJson('/api/projects');
      const created = projects.find((p) => p.title === draftTitle);
      check('作品已写入数据库', Boolean(created), created?.title);
      if (created) {
        createdProjectId = created.id;
        const overview = await apiJson('/api/projects/overview');
        const item = overview.find((p) => p.id === created.id);
        check(
          '书架统计正确',
          item && item.chapterCount >= 3 && item.entityCount >= 3,
          `${item?.chapterCount} 章 / ${item?.entityCount} 设定`,
        );
      }

      ws.close();
    } finally {
      child.kill();
    }
  } finally {
    if (createdProjectId) {
      await fetch(`${API}/api/projects/${createdProjectId}`, { method: 'DELETE' }).catch(() => {});
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
