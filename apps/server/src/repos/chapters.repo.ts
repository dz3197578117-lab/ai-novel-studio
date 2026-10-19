import type { Chapter, ChapterStatus, ChapterSummary, ID, Volume } from '@novelforge/shared';
import { countWords, getDb, newId, nowIso } from '../db.js';

interface VolumeRow {
  id: string;
  project_id: string;
  title: string;
  summary: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface ChapterRow {
  id: string;
  project_id: string;
  volume_id: string | null;
  title: string;
  sort_order: number;
  outline: string;
  content: string;
  status: ChapterStatus;
  word_count: number;
  summary: string;
  created_at: string;
  updated_at: string;
}

const toVolume = (r: VolumeRow): Volume => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  summary: r.summary,
  order: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toChapter = (r: ChapterRow): Chapter => ({
  id: r.id,
  projectId: r.project_id,
  volumeId: r.volume_id,
  title: r.title,
  order: r.sort_order,
  outline: r.outline,
  content: r.content,
  status: r.status,
  wordCount: r.word_count,
  summary: r.summary,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toChapterSummary = (r: ChapterRow): ChapterSummary => ({
  id: r.id,
  projectId: r.project_id,
  volumeId: r.volume_id,
  title: r.title,
  order: r.sort_order,
  wordCount: r.word_count,
  status: r.status,
  updatedAt: r.updated_at,
});

// ───────────────────────── 卷 ─────────────────────────

export function listVolumes(projectId: ID): Volume[] {
  const rows = getDb()
    .prepare('SELECT * FROM volumes WHERE project_id = ? ORDER BY sort_order, created_at')
    .all(projectId) as unknown as VolumeRow[];
  return rows.map(toVolume);
}

export function createVolume(projectId: ID, title: string, summary = ''): Volume {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM volumes WHERE project_id = ?')
    .get(projectId) as { m: number };
  db.prepare(
    `INSERT INTO volumes (id, project_id, title, summary, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, projectId, title, summary, max.m + 1, ts, ts);
  return toVolume(
    db.prepare('SELECT * FROM volumes WHERE id = ?').get(id) as unknown as VolumeRow,
  );
}

export function updateVolume(
  id: ID,
  patch: { title?: string; summary?: string; order?: number },
): Volume | null {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM volumes WHERE id = ?').get(id) as
    | VolumeRow
    | undefined;
  if (!cur) return null;
  db.prepare(
    'UPDATE volumes SET title=?, summary=?, sort_order=?, updated_at=? WHERE id=?',
  ).run(
    patch.title ?? cur.title,
    patch.summary ?? cur.summary,
    patch.order ?? cur.sort_order,
    nowIso(),
    id,
  );
  return toVolume(db.prepare('SELECT * FROM volumes WHERE id = ?').get(id) as unknown as VolumeRow);
}

export function deleteVolume(id: ID): boolean {
  const res = getDb().prepare('DELETE FROM volumes WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

// ───────────────────────── 章节 ─────────────────────────

export function listChapters(projectId: ID): ChapterSummary[] {
  const rows = getDb()
    .prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY sort_order, created_at')
    .all(projectId) as unknown as ChapterRow[];
  return rows.map(toChapterSummary);
}

export function getChapter(id: ID): Chapter | null {
  const row = getDb().prepare('SELECT * FROM chapters WHERE id = ?').get(id) as
    | ChapterRow
    | undefined;
  return row ? toChapter(row) : null;
}

export interface ChapterInput {
  title: string;
  volumeId?: ID | null;
  outline?: string;
  content?: string;
  status?: ChapterStatus;
}

export function createChapter(projectId: ID, input: ChapterInput): Chapter {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM chapters WHERE project_id = ?')
    .get(projectId) as { m: number };
  const content = input.content ?? '';
  db.prepare(
    `INSERT INTO chapters (id, project_id, volume_id, title, sort_order, outline, content, status, word_count, summary, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    projectId,
    input.volumeId ?? null,
    input.title,
    max.m + 1,
    input.outline ?? '',
    content,
    input.status ?? 'outline',
    countWords(content),
    '',
    ts,
    ts,
  );
  return getChapter(id)!;
}

export function updateChapter(id: ID, patch: Partial<ChapterInput>): Chapter | null {
  const cur = getChapter(id);
  if (!cur) return null;
  const db = getDb();
  const content = patch.content ?? cur.content;
  db.prepare(
    `UPDATE chapters SET volume_id=?, title=?, outline=?, content=?, status=?, word_count=?, updated_at=? WHERE id=?`,
  ).run(
    patch.volumeId === undefined ? cur.volumeId : patch.volumeId,
    patch.title ?? cur.title,
    patch.outline ?? cur.outline,
    content,
    patch.status ?? cur.status,
    countWords(content),
    nowIso(),
    id,
  );
  return getChapter(id);
}

export function setChapterSummary(id: ID, summary: string): void {
  getDb()
    .prepare('UPDATE chapters SET summary=?, updated_at=? WHERE id=?')
    .run(summary, nowIso(), id);
}

export function deleteChapter(id: ID): boolean {
  const res = getDb().prepare('DELETE FROM chapters WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

/** 按 order 重排章节（拖拽排序用） */
export function reorderChapters(projectId: ID, orderedIds: ID[]): void {
  const db = getDb();
  const stmt = db.prepare(
    'UPDATE chapters SET sort_order=?, updated_at=? WHERE id=? AND project_id=?',
  );
  const ts = nowIso();
  db.exec('BEGIN');
  try {
    orderedIds.forEach((id, idx) => stmt.run(idx, ts, id, projectId));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 取某章之前的所有章节摘要，最新的优先，用于长期记忆 */
export function listPriorSummaries(
  projectId: ID,
  beforeOrder: number,
  limit = 20,
): { id: ID; title: string; summary: string; order: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT id, title, summary, sort_order FROM chapters
       WHERE project_id = ? AND sort_order < ? AND summary <> ''
       ORDER BY sort_order DESC LIMIT ?`,
    )
    .all(projectId, beforeOrder, limit) as unknown as {
    id: string;
    title: string;
    summary: string;
    sort_order: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    order: r.sort_order,
  }));
}
