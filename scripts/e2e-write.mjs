/**
 * 写作台 AI 链路端到端测试：
 * 整章生成 → 替换正文、续写 → 追加到末尾。
 *
 * 全程使用「临时章节」，不碰已有作品正文；结束后删除并还原设置。
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
const TMP_CHAPTER = 'E2E临时章';

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

/** 与 mock 的 SAMPLE 对应 */
const SAMPLE_TEXT = '外院的屋子比主宅冷得多。';

async function main() {
  const originalSettings = dumpSettings();
  const mock = await ensureMock();
  let chapterId = null;

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
        maxTokens: 2048,
      }),
    });
    await apiJson(`/api/profiles/${created.id}/activate`, { method: 'POST' });

    const projects = await apiJson('/api/projects');
    const project = projects.find((p) => p.title === '长夜行') ?? projects[0];
    check('找到演示项目', Boolean(project), project?.title);

    // 建一个临时章节，避免动到用户正在写的内容
    const chapter = await apiJson(`/api/projects/${project.id}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: TMP_CHAPTER,
        outline: '测试大纲：主角在雪夜遇到一个陌生人。',
      }),
    });
    chapterId = chapter.id;

    const profile = path.join(os.tmpdir(), `nf-write-${Date.now()}`);
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

      // 进入写作台
      check(
        '打开作品',
        await evaluate(`(() => {
          const card = Array.from(document.querySelectorAll('.shelf .lib-card')).find(c => c.textContent.includes('长夜行')) ?? document.querySelector('.shelf .lib-card');
          if (card) { card.click(); return true; }
          return false;
        })()`),
      );
      await sleep(2200);

      // 选中临时章节
      check(
        '选中临时章节',
        await evaluate(`(() => {
          const t = Array.from(document.querySelectorAll('.chapter-item')).find(e => e.textContent.includes(${JSON.stringify(TMP_CHAPTER)}));
          if (t) { t.click(); return true; }
          return false;
        })()`),
      );
      await sleep(1200);
      const emptyContent = await evaluate('document.querySelector("textarea.fiction")?.value ?? ""');
      check('章节初始为空', emptyContent.length === 0, `${emptyContent.length} 字`);

      // ── 1. 整章生成 → 替换正文 ──
      check('点击「整章生成」', await clickText('整章生成'));

      let streamed = '';
      for (let i = 0; i < 30; i++) {
        await sleep(300);
        streamed = await evaluate('document.querySelector(".result-box")?.textContent ?? ""');
        if (streamed.includes('柴是有的')) break;
      }
      check('整章生成有流式结果', streamed.includes(SAMPLE_TEXT), `${streamed.length} 字`);

      await evaluate('window.confirm = () => true');
      check('点击「替换正文」', await clickText('替换正文'));
      await sleep(2200); // 等自动保存

      const afterReplace = await evaluate('document.querySelector("textarea.fiction").value');
      check(
        '正文被整段替换（而非追加）',
        afterReplace.includes(SAMPLE_TEXT) && afterReplace.length <= streamed.length + 5,
        `${afterReplace.length} 字`,
      );

      const saved = await apiJson(`/api/chapters/${chapterId}`);
      check('替换结果已落库', saved.content.includes(SAMPLE_TEXT), `${saved.wordCount} 字`);

      // ── 2. 续写 → 追加到末尾 ──
      check(
        '切到「续写」模式',
        await evaluate(`(() => {
          const b = Array.from(document.querySelectorAll('.ai-tabs button')).find(x => x.textContent.trim() === '续写');
          if (b) { b.click(); return true; }
          return false;
        })()`),
      );
      await sleep(400);
      const beforeAppend = (await evaluate('document.querySelector("textarea.fiction").value')).length;

      check('点击「生成」', await clickText('生成'));
      let appending = '';
      for (let i = 0; i < 30; i++) {
        await sleep(300);
        appending = await evaluate('document.querySelector(".result-box")?.textContent ?? ""');
        if (appending.includes('柴是有的')) break;
      }
      check('续写有流式结果', appending.length > 10, `${appending.length} 字`);

      check('点击「追加到末尾」', await clickText('追加到末尾'));
      await sleep(2200);
      const afterAppend = await evaluate('document.querySelector("textarea.fiction").value');
      check(
        '追加后正文变长且保留原内容',
        afterAppend.length > beforeAppend && afterAppend.startsWith(afterReplace.slice(0, 20)),
        `${beforeAppend} → ${afterAppend.length} 字`,
      );

      ws.close();
    } finally {
      child.kill();
    }
  } finally {
    if (chapterId) {
      await fetch(`${API}/api/chapters/${chapterId}`, { method: 'DELETE' }).catch(() => {});
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
