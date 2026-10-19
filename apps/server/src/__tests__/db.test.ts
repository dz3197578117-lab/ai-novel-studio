import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../db.js';

test('内存库能建出所有表', () => {
  const db = openMemoryDb();
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ['projects', 'entities', 'volumes', 'chapters', 'images', 'settings']) {
      assert.ok(names.includes(t), `缺少表 ${t}`);
    }
  } finally {
    db.close();
  }
});

test('外键约束生效（不存在的项目不能插章节）', () => {
  const db = openMemoryDb();
  try {
    assert.throws(() => {
      db.prepare(
        'INSERT INTO chapters (id, project_id, title, sort_order, outline, content, status, word_count, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run('c1', 'nonexistent', 't', 0, '', '', 'outline', 0, '', 'x', 'x');
    });
  } finally {
    db.close();
  }
});

test('删除项目级联删除章节', () => {
  const db = openMemoryDb();
  try {
    const ts = new Date().toISOString();
    db.prepare(
      'INSERT INTO projects (id,title,logline,genre,target_words,status,style_guide,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('p1', 'T', '', '', 0, 'drafting', '', ts, ts);
    db.prepare(
      'INSERT INTO chapters (id, project_id, title, sort_order, outline, content, status, word_count, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run('c1', 'p1', '第一章', 0, '', '', 'outline', 0, '', ts, ts);

    db.prepare('DELETE FROM projects WHERE id = ?').run('p1');
    const left = db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number };
    assert.equal(left.n, 0);
  } finally {
    db.close();
  }
});
