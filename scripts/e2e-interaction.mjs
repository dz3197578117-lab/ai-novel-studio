/**
 * 交互逻辑端到端测试：切章保数据、重命名、删除、新建编号、快捷键、AI 插入。
 * 全部操作在临时章节上进行，结束后清理。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9111;
const UI = process.env.UI_BASE ?? 'http://127.0.0.1:5173/';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function json(pathname, init) {
  const res = await fetch(`${API}${pathname}`, init);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`);
  return res.json();
}

const created = [];

async function main() {
  const projects = await json('/api/projects');
  const project = projects[0];

  const mk = async (title) => {
    const c = await json(`/api/projects/${project.id}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    created.push(c.id);
    return c;
  };

  const switcher = await mk('交互测试·切章');
  const victim = await mk('交互测试·待删除');

  const profile = path.join(os.tmpdir(), `nf-ix-${Date.now()}`);
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
    const clickChapter = (title) =>
      evaluate(`(() => {
        const t = Array.from(document.querySelectorAll('.chapter-item')).find(e => e.textContent.includes(${JSON.stringify(title)}));
        if (t) t.click();
        return !!t;
      })()`);
    const setFiction = (text) =>
      evaluate(`(() => {
        const ta = document.querySelector('textarea.fiction');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: UI });
    await sleep(4200);

    // 首页是书架，先点第一本进入写作台
    await evaluate(`(() => {
      const card = document.querySelector('.shelf .lib-card');
      if (card) card.click();
      return !!card;
    })()`);
    await sleep(2200);

    // ── 1. 切章不丢字 ──
    await clickChapter('交互测试·切章');
    await sleep(1000);
    const MARK = '切章前输入的内容';
    await setFiction(MARK);
    await sleep(120);
    await clickChapter('第一章');
    await sleep(2600);
    const saved = await json(`/api/chapters/${switcher.id}`);
    check('切章前未保存内容不丢失', saved.content.includes(MARK), `${saved.content.length} 字`);

    // ── 2. Ctrl+S 立即保存（不等 1.2s 防抖）──
    await clickChapter('交互测试·切章');
    await sleep(900);
    const QUICK = '快捷键保存的内容';
    await setFiction(QUICK);
    await evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
      return true;
    })()`);
    await sleep(700);
    const afterShortcut = await json(`/api/chapters/${switcher.id}`);
    check('Ctrl+S 立即保存', afterShortcut.content.includes(QUICK), `${afterShortcut.content.length} 字`);

    // ── 3. AI 结果插入到光标（不覆盖全文）──
    await evaluate(`(() => {
      const ta = document.querySelector('textarea.fiction');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '前半句。后半句。');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      ta.setSelectionRange(4, 8); // 选中「后半句。」
      return true;
    })()`);
    await sleep(300);
    await evaluate(`(() => {
      window.dispatchEvent(new CustomEvent('novelforge:apply', { detail: { text: '【插入的文本】', mode: 'insert' } }));
      return true;
    })()`);
    await sleep(500);
    const inserted = await evaluate('document.querySelector("textarea.fiction").value');
    check('AI 插入到光标并替换选区', inserted === '前半句。【插入的文本】', inserted);

    // ── 4. 重命名章节 ──
    await clickChapter('交互测试·待删除');
    await sleep(900);
    const renamed = await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.chapter-item')).find(e => e.textContent.includes('交互测试·待删除'));
      if (!row) return false;
      const btn = Array.from(row.querySelectorAll('.icon-btn')).find(b => b.textContent.includes('✎'));
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    check('点击重命名按钮', renamed);
    await sleep(400);
    const setTitle = await evaluate(`(() => {
      const input = document.querySelector('.chapter-item.editing .rename-input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '交互测试·已改名');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    check('输入新标题并回车', setTitle);
    await sleep(1200);
    const listAfterRename = await evaluate(
      'Array.from(document.querySelectorAll(".chapter-item")).map(e=>e.textContent).join("|")',
    );
    check('章节列表显示新标题', listAfterRename.includes('交互测试·已改名'));

    // ── 5. 删除章节（当前章节被删后自动切换）──
    const targetId = victim.id;
    await evaluate('window.confirm = () => true');
    const deleted = await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.chapter-item')).find(e => e.textContent.includes('交互测试·已改名'));
      if (!row) return false;
      const btn = Array.from(row.querySelectorAll('.icon-btn')).find(b => b.textContent.includes('×'));
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    check('点击删除章节', deleted);
    await sleep(1600);
    const stillThere = await evaluate(
      'Array.from(document.querySelectorAll(".chapter-item")).map(e=>e.textContent).join("|")',
    );
    check('已删除的章节从列表消失', !stillThere.includes('已改名'));
    const gone = await fetch(`${API}/api/chapters/${targetId}`);
    check('数据库中章节已删除', gone.status === 404, `HTTP ${gone.status}`);
    const stillEditing = await evaluate('!!document.querySelector("textarea.fiction")');
    check('删除当前章后自动切到其它章节', stillEditing === true);

    // ── 6. 新建章节编号不重复 ──
    const before = await json(`/api/projects/${project.id}/chapters`);
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('章＋'));
      if (b) b.click(); return !!b;
    })()`);
    await sleep(1800);
    const after = await json(`/api/projects/${project.id}/chapters`);
    const titles = after.map((c) => c.title);
    const dup = titles.filter((t, i) => titles.indexOf(t) !== i);
    check('新建章节标题不重复', dup.length === 0, `${titles.length} 章，重复 ${dup.length}`);
    const added = after.find((c) => !before.some((b) => b.id === c.id));
    if (added) created.push(added.id);

    ws.close();
  } finally {
    child.kill();
    for (const cid of created) {
      await fetch(`${API}/api/chapters/${cid}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exitCode = 1;
});
