import type {
  ID,
  KnowledgeDoc,
  KnowledgeHit,
  KnowledgeDocInput,
  Scene,
  SceneInput,
} from '@novelforge/shared';
import { getDb, newId, nowIso, transaction } from '../db.js';

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

/**
 * 把长文切成适合检索的片段。
 * 相邻片段保留 80 字重叠：一个事实刚好跨在两段边界时，两段都能检索到它。
 */
export function chunkText(content: string, size = 500, overlap = 80): string[] {
  const paragraphs = content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  const ov = Math.max(0, Math.min(overlap, Math.floor(size / 2)));
  let buf = '';

  for (const p of paragraphs) {
    if (buf && (buf + '\n\n' + p).length > size) {
      chunks.push(buf);
      // 下一段带上上一段的尾巴，避免边界信息丢失
      const tail = ov > 0 ? buf.slice(-ov) : '';
      buf = tail ? `${tail}\n\n${p}` : p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }

    // 单段超长时硬切，同样保留重叠
    while (buf.length > size * 2) {
      chunks.push(buf.slice(0, size));
      const tail = ov > 0 ? buf.slice(size - ov, size) : '';
      buf = tail + buf.slice(size);
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.length ? chunks : [content.slice(0, size)];
}

/** 中文 2-gram + 英文单词，和检索时的切词保持一致 */
function indexTerms(text: string): string[] {
  const terms = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9_]{2,}/g) ?? []) terms.add(w);
  const cjk = lower.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) terms.add(cjk.slice(i, i + 2));
  return [...terms];
}

function insertChunkTerms(projectId: ID, chunkId: ID, text: string): void {
  const stmt = getDb().prepare(
    'INSERT OR IGNORE INTO knowledge_terms (project_id, term, chunk_id) VALUES (?,?,?)',
  );
  for (const term of indexTerms(text)) stmt.run(projectId, term, chunkId);
}

export function createDoc(projectId: ID, input: KnowledgeDocInput): KnowledgeDoc {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  const chunks = chunkText(input.content);

  // 文档、片段、倒排词一起写：中途失败不会留下“有片段没索引”的半套数据
  transaction(() => {
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

    const stmt = db.prepare(
      'INSERT INTO knowledge_chunks (id, doc_id, project_id, chunk_index, text) VALUES (?,?,?,?,?)',
    );
    chunks.forEach((text, i) => {
      const chunkId = newId();
      stmt.run(chunkId, id, projectId, i, text);
      insertChunkTerms(projectId, chunkId, text);
    });
  });

  return getDoc(id)!;
}

export function deleteDoc(id: ID): boolean {
  const db = getDb();
  let ok = false;
  transaction(() => {
    // 先删倒排词，再删文档（chunks 由外键级联删除）
    db.prepare(
      'DELETE FROM knowledge_terms WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE doc_id = ?)',
    ).run(id);
    ok = Number(db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(id).changes) > 0;
  });
  return ok;
}

const INDEX_VERSION_KEY = 'knowledge_index_version';
const INDEX_VERSION = '3';

/**
 * 旧版本资料没有重叠分块，也没有倒排索引。启动时重建一次。
 * 用 settings 里的版本号控制，之后只跑一次。
 */
export function reindexKnowledgeIfNeeded(): void {
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(INDEX_VERSION_KEY) as { value: string } | undefined;
  if (row) {
    try {
      if (JSON.parse(row.value) === INDEX_VERSION) return;
    } catch {
      /* 脏值按未建索引处理 */
    }
  }

  transaction(() => {
    db.exec('DELETE FROM knowledge_terms');
    db.exec('DELETE FROM knowledge_chunks');

    const docs = db
      .prepare('SELECT id, project_id, content FROM knowledge_docs')
      .all() as unknown as { id: string; project_id: string; content: string }[];
    const stmt = db.prepare(
      'INSERT INTO knowledge_chunks (id, doc_id, project_id, chunk_index, text) VALUES (?,?,?,?,?)',
    );
    for (const doc of docs) {
      chunkText(doc.content).forEach((text, i) => {
        const chunkId = newId();
        stmt.run(chunkId, doc.id, doc.project_id, i, text);
        insertChunkTerms(doc.project_id, chunkId, text);
      });
    }

    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(INDEX_VERSION_KEY, JSON.stringify(INDEX_VERSION));
  });
}

interface ChunkHitRow {
  doc_id: string;
  chunk_index: number;
  text: string;
  doc_title: string;
  doc_source: string;
}

function scoreChunks(rows: ChunkHitRow[], terms: Set<string>, limit: number): KnowledgeHit[] {
  return rows
    .map((r) => {
      const text = r.text.toLowerCase();
      let matched = 0;
      let weighted = 0;
      for (const t of terms) {
        if (text.includes(t)) {
          matched += 1;
          // 长词更可信：命中一个 4 字词比命中一个「的时」有价值
          weighted += Math.min(4, t.length);
        }
      }
      if (matched === 0) return null;
      const coverage = matched / terms.size;
      return {
        docId: r.doc_id,
        docTitle: r.doc_title,
        source: r.doc_source,
        chunkIndex: r.chunk_index,
        text: r.text,
        score: Math.round(weighted * (0.6 + coverage) * 100) / 100,
      };
    })
    .filter((r): r is KnowledgeHit => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * 关键词检索：中文按 2-gram 切分，英文按单词。
 *
 * 主路径走 knowledge_terms 倒排表（project_id + term 有联合主键），
 * 只把命中片段读进内存再精算；索引尚未覆盖的旧资料回退到 LIKE。
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

  // 长词更能区分文档；短 2-gram 命中面太宽，排序后限量
  const probes = [...terms].sort((a, b) => b.length - a.length).slice(0, 24);
  const db = getDb();
  const placeholders = probes.map(() => '?').join(',');

  // 1) 倒排索引：按命中词数取候选，再精算
  try {
    const indexed = db
      .prepare(
        `SELECT chunk_id, COUNT(*) AS hits FROM knowledge_terms
         WHERE project_id = ? AND term IN (${placeholders})
         GROUP BY chunk_id ORDER BY hits DESC LIMIT 500`,
      )
      .all(projectId, ...probes) as unknown as { chunk_id: string; hits: number }[];

    if (indexed.length > 0) {
      const ids = indexed.map((r) => r.chunk_id);
      const marks = ids.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT c.doc_id, c.chunk_index, c.text, d.title AS doc_title, d.source AS doc_source
           FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id
           WHERE c.id IN (${marks})`,
        )
        .all(...ids) as unknown as ChunkHitRow[];
      const scored = scoreChunks(rows, terms, limit);
      if (scored.length > 0) return scored;
    }
  } catch (e) {
    // 索引表缺失/旧库未重建时不阻塞生成
    console.warn('[knowledge] 倒排检索失败，回退 LIKE:', (e as Error).message);
  }

  // 2) 兜底：索引没覆盖到的旧资料
  const esc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
  const where = probes.map(() => `c.text LIKE ? ESCAPE '\\'`).join(' OR ');
  const rows = db
    .prepare(
      `SELECT c.doc_id, c.chunk_index, c.text, d.title AS doc_title, d.source AS doc_source
       FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id
       WHERE c.project_id = ? AND c.text <> '' AND (${where})
       LIMIT 1200`,
    )
    .all(projectId, ...probes.map((t) => `%${esc(t)}%`)) as unknown as ChunkHitRow[];

  return scoreChunks(rows, terms, limit);
}
