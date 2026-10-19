import type {
  ID,
  KnowledgeDoc,
  KnowledgeHit,
  KnowledgeDocInput,
  Scene,
  SceneInput,
} from '@novelforge/shared';
import { getDb, newId, nowIso } from '../db.js';

// ───────────────────────── 场景卡 ─────────────────────────

interface SceneRow {
  id: string;
  project_id: string;
  chapter_id: string;
  sort_order: number;
  title: string;
  pov: string;
  location: string;
  goal: string;
  conflict: string;
  outcome: string;
  key_lines: string;
  created_at: string;
  updated_at: string;
}

const toScene = (r: SceneRow): Scene => ({
  id: r.id,
  projectId: r.project_id,
  chapterId: r.chapter_id,
  order: r.sort_order,
  title: r.title,
  pov: r.pov,
  location: r.location,
  goal: r.goal,
  conflict: r.conflict,
  outcome: r.outcome,
  keyLines: r.key_lines,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listScenes(chapterId: ID): Scene[] {
  const rows = getDb()
    .prepare('SELECT * FROM scenes WHERE chapter_id = ? ORDER BY sort_order, created_at')
    .all(chapterId) as unknown as SceneRow[];
  return rows.map(toScene);
}

export function listScenesByProject(projectId: ID): Scene[] {
  const rows = getDb()
    .prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY chapter_id, sort_order')
    .all(projectId) as unknown as SceneRow[];
  return rows.map(toScene);
}

export function createScene(
  projectId: ID,
  chapterId: ID,
  input: SceneInput,
  order?: number,
): Scene {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  const idx =
    order ??
    ((db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM scenes WHERE chapter_id = ?')
      .get(chapterId) as { m: number }).m +
      1);
  db.prepare(
    `INSERT INTO scenes (id, project_id, chapter_id, sort_order, title, pov, location, goal, conflict, outcome, key_lines, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    projectId,
    chapterId,
    idx,
    input.title,
    input.pov ?? '',
    input.location ?? '',
    input.goal ?? '',
    input.conflict ?? '',
    input.outcome ?? '',
    input.keyLines ?? '',
    ts,
    ts,
  );
  return toScene(db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as unknown as SceneRow);
}

export function updateScene(id: ID, patch: Partial<SceneInput>): Scene | null {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as SceneRow | undefined;
  if (!cur) return null;
  db.prepare(
    `UPDATE scenes SET title=?, pov=?, location=?, goal=?, conflict=?, outcome=?, key_lines=?, updated_at=? WHERE id=?`,
  ).run(
    patch.title ?? cur.title,
    patch.pov ?? cur.pov,
    patch.location ?? cur.location,
    patch.goal ?? cur.goal,
    patch.conflict ?? cur.conflict,
    patch.outcome ?? cur.outcome,
    patch.keyLines ?? cur.key_lines,
    nowIso(),
    id,
  );
  return toScene(db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as unknown as SceneRow);
}

export function deleteScene(id: ID): boolean {
  const res = getDb().prepare('DELETE FROM scenes WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

export function clearScenes(chapterId: ID): void {
  getDb().prepare('DELETE FROM scenes WHERE chapter_id = ?').run(chapterId);
}

// ───────────────────────── 知识库 ─────────────────────────

interface DocRow {
  id: string;
  project_id: string;
  title: string;
  source: string;
  tags: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface ChunkRow {
  id: string;
  doc_id: string;
  project_id: string;
  chunk_index: number;
  text: string;
}

function toDoc(r: DocRow, chunkCount: number): KnowledgeDoc {
  let tags: string[] = [];
  try {
    const v = JSON.parse(r.tags);
    if (Array.isArray(v)) tags = v as string[];
  } catch {
    /* ignore */
  }
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    source: r.source,
    tags,
    content: r.content,
    chunkCount,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listDocs(projectId: ID): KnowledgeDoc[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM knowledge_docs WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as unknown as DocRow[];
  const counts = db
    .prepare('SELECT doc_id, COUNT(*) AS n FROM knowledge_chunks WHERE project_id = ? GROUP BY doc_id')
    .all(projectId) as unknown as { doc_id: string; n: number }[];
  const map = new Map(counts.map((c) => [c.doc_id, c.n]));
  return rows.map((r) => toDoc(r, map.get(r.id) ?? 0));
}

export function getDoc(id: ID): KnowledgeDoc | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(id) as DocRow | undefined;
  if (!row) return null;
  const n = db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE doc_id = ?').get(id) as {
    n: number;
  };
  return toDoc(row, n.n);
}

/** 把长文切成适合检索的片段 */
export function chunkText(content: string, size = 500): string[] {
  const paragraphs = content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).length > size && buf) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    // 单段超长时硬切
    while (buf.length > size * 2) {
      chunks.push(buf.slice(0, size));
      buf = buf.slice(size);
    }
  }
  if (buf.trim()) chunks.push(buf);
  return chunks.length ? chunks : [content.slice(0, size)];
}

export function createDoc(projectId: ID, input: KnowledgeDocInput): KnowledgeDoc {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO knowledge_docs (id, project_id, title, source, tags, content, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    projectId,
    input.title,
    input.source ?? '',
    JSON.stringify(input.tags ?? []),
    input.content,
    ts,
    ts,
  );

  const chunks = chunkText(input.content);
  const stmt = db.prepare(
    'INSERT INTO knowledge_chunks (id, doc_id, project_id, chunk_index, text) VALUES (?,?,?,?,?)',
  );
  chunks.forEach((text, i) => stmt.run(newId(), id, projectId, i, text));

  return getDoc(id)!;
}

export function deleteDoc(id: ID): boolean {
  const res = getDb().prepare('DELETE FROM knowledge_docs WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

/**
 * 关键词检索：中文按 2-gram 切分，英文按单词。
 * 没有向量模型也能用，够本地单人资料库的场景。
 */
export function searchKnowledge(projectId: ID, query: string, limit = 5): KnowledgeHit[] {
  const q = query.trim();
  if (!q) return [];

  const terms = new Set<string>();
  const lower = q.toLowerCase();
  for (const w of lower.match(/[a-z0-9_]{2,}/g) ?? []) terms.add(w);
  const cjk = lower.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) terms.add(cjk.slice(i, i + 2));
  if (terms.size === 0) terms.add(lower);

  const rows = getDb()
    .prepare(
      `SELECT c.*, d.title AS doc_title, d.source AS doc_source
       FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id
       WHERE c.project_id = ?`,
    )
    .all(projectId) as unknown as (ChunkRow & { doc_title: string; doc_source: string })[];

  const scored = rows
    .map((r) => {
      const text = r.text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (text.includes(t)) score += t.length >= 2 ? 2 : 1;
      }
      return {
        docId: r.doc_id,
        docTitle: r.doc_title,
        source: r.doc_source,
        chunkIndex: r.chunk_index,
        text: r.text,
        score,
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}
