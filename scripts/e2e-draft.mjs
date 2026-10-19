/**
 * 「对话式 AI 生成小说」端到端测试：
 * 打开对话框 → 看到 AI 反问 → 点选项回答 → 聊清楚 → 生成方案 → 创建 → 进入写作台。
 *
 * 会临时把模型指向本地 mock，结束后还原 settings 表并删除测试作品。
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
  let createdProjectId = null;

  try {
    const created = await apiJson('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'E2E Mock',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        apiKey: 'mock-key',
        model: 'mock-model',
        temperature: 0.8,
        maxTokens: 4096,
      }),
    });
    await apiJson(`/api/profiles/${created.id}/activate`, { method: 'POST' });

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

      // 1. 书架上打开对话框
      const opened = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('AI 生成小说'));
        if (b) { b.click(); return true; }
        return false;
      })()`);
      check('书架上存在「AI 生成小说」入口', opened);
      await sleep(800);
      const title = await evaluate('document.querySelector(".modal h2")?.textContent ?? ""');
      check('对话框已打开', title.includes('AI 生成小说'), title);

      // 2. AI 先开口，并给类型快捷选项
      const greeting = await evaluate(
        'document.querySelector(".chat-bubble.assistant")?.textContent ?? ""',
      );
      check('AI 主动发起对话', greeting.length > 5, greeting.slice(0, 40));

      const starterCount = await evaluate('document.querySelectorAll(".chat-options .count-chip").length');
      check('提供类型快捷选项', starterCount >= 3, `${starterCount} 个`);

      // 3. 点一个类型 → 发出去
      const clickedStarter = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('.chat-options .count-chip'))
          .find(x => x.textContent.includes('古典玄幻'));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      check('点击类型选项', clickedStarter);

      // 4. 等 AI 反问
      let optionsAfter = 0;
      for (let i = 0; i < 25; i++) {
        await sleep(400);
        optionsAfter = await evaluate('document.querySelectorAll(".chat-options .count-chip").length');
        if (optionsAfter > 0) break;
      }
      const userBubbles = await evaluate('document.querySelectorAll(".chat-bubble.user").length');
      check('用户消息已上屏', userBubbles >= 1, `${userBubbles} 条`);
      const bubbles = await evaluate('document.querySelectorAll(".chat-bubble.assistant").length');
      check('AI 反问并给出选项', optionsAfter >= 2 && bubbles >= 2, `选项 ${optionsAfter} 个`);

      // 5. 回答 AI 的追问
      await evaluate(`(() => {
        const b = document.querySelector('.chat-options .count-chip');
        if (b) b.click();
        return !!b;
      })()`);

      // 6. 等 AI 表示「聊清楚了」
      let brief = '';
      for (let i = 0; i < 25; i++) {
        await sleep(400);
        brief = await evaluate('document.querySelector(".brief-preview")?.textContent ?? ""');
        if (brief) break;
      }
      check('AI 汇总出需求', brief.length > 10, brief.slice(0, 50));

      const hasStartBtn = await evaluate(`(() => {
        return Array.from(document.querySelectorAll('.modal button')).some(b => b.textContent.includes('开始生成方案'));
      })()`);
      check('出现「开始生成方案」按钮', hasStartBtn);

      // 7. 生成方案
      const clickedGenerate = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.includes('开始生成方案'));
        if (b && !b.disabled) { b.click(); return true; }
        return false;
      })()`);
      check('点击「开始生成方案」', clickedGenerate);

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

      // 8. 创建作品
      const clickedCreate = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.includes('创建这本书'));
        if (b && !b.disabled) { b.click(); return true; }
        return false;
      })()`);
      check('点击「创建这本书」', clickedCreate);

      let inWorkspace = false;
      for (let i = 0; i < 25; i++) {
        await sleep(400);
        inWorkspace = await evaluate('!!document.querySelector(".editor-body")');
        if (inWorkspace) break;
      }
      check('创建后进入写作台', inWorkspace === true);

      const chapterCount = await evaluate('document.querySelectorAll(".chapter-item").length');
      check('新作品带入了章节', chapterCount >= 3, `${chapterCount} 章`);

      // 9. 数据落库
      const projects = await apiJson('/api/projects');
      const proj = projects.find((p) => p.title === draftTitle);
      check('作品已写入数据库', Boolean(proj), proj?.title);
      if (proj) {
        createdProjectId = proj.id;
        const overview = await apiJson('/api/projects/overview');
        const item = overview.find((p) => p.id === proj.id);
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
