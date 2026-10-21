import type {
  Chapter,
  ChapterStatus,
  ChapterSummary,
  FactPoint,
  FactSheet,
  ID,
  Volume,
} from '@novelforge/shared';
import { countWords, getDb, newId, nowIso } from '../db.js';
import { snapshotChapter } from './versions.repo.js';

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
  beats: string | null;
  facts: string | null;
  fact_sheet: string | null;
  pov: string | null;
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
  beats: r.beats ?? '',
  facts: parseFacts(r.facts),
  factSheet: parseFactSheet(r.fact_sheet),
  pov: r.pov ? (r.pov as Chapter['pov']) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** 事实核查单（含引用片段）；解析失败当作没有，不影响章节本身 */
function parseFactSheet(raw: string | null): FactSheet | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as FactSheet;
    if (v && Array.isArray(v.points) && Array.isArray(v.hits)) return v;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** facts 列存 JSON；解析失败当作空，不让脏数据拖垮整个章节读取 */
function parseFacts(raw: string | null): FactPoint[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is FactPoint => Boolean(x) && typeof (x as FactPoint).point === 'string')
      .slice(0, 20);
  } catch {
    return [];
  }
}

/** 章节摘要行：显式不含 content，避免把整本书正文读进内存 */
type ChapterSummaryRow = Pick<
  ChapterRow,
  | 'id'
  | 'project_id'
  | 'volume_id'
  | 'title'
  | 'sort_order'
  | 'word_count'
  | 'status'
  | 'updated_at'
>;

const toChapterSummary = (r: ChapterSummaryRow): ChapterSummary => ({
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
  // 只取摘要需要的列：之前用 SELECT * 会把每章正文一起读出来再丢掉，
  // 上千章时会白白占用几十 MB 内存并阻塞事件循环。
  const rows = getDb()
    .prepare(
      `SELECT id, project_id, volume_id, title, sort_order, word_count, status, updated_at
       FROM chapters WHERE project_id = ? ORDER BY sort_order, created_at`,
    )
    .all(projectId) as unknown as ChapterSummaryRow[];
  return rows.map(toChapterSummary);
}

/** 一次查出整本书的完整章节（导出、备份用），避免逐章 N+1 查询 */
export function listChaptersWithContent(projectId: ID, ids?: ID[]): Chapter[] {
  const db = getDb();
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM chapters WHERE project_id = ? AND id IN (${placeholders})
         ORDER BY sort_order, created_at`,
      )
      .all(projectId, ...ids) as unknown as ChapterRow[];
    return rows.map(toChapter);
  }
  const rows = db
    .prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY sort_order, created_at')
    .all(projectId) as unknown as ChapterRow[];
  return rows.map(toChapter);
}

/**
 * 只取「目录/规划」需要的列，正文固定为空串。
 *
 * 一致性检查、补大纲、整改这些链路只需要标题/大纲/摘要，
 * 以前用 listChapters().map(getChapter) 会把每一章正文都读进内存（1000 章可达几十 MB），
 * 而且每章一次查询。
 */
export function listChapterDigests(projectId: ID): Chapter[] {
  const rows = getDb()
    .prepare(
      `SELECT id, project_id, volume_id, title, sort_order, outline, '' AS content,
              status, word_count, summary, beats, facts, pov, created_at, updated_at
       FROM chapters WHERE project_id = ? ORDER BY sort_order, created_at`,
    )
    .all(projectId) as unknown as ChapterRow[];
  return rows.map(toChapter);
}

/** 全书最后一章的正文（一致性检查只判断「当下写法」，不需要全部正文） */
export function getLastChapterContent(projectId: ID): string {
  const row = getDb()
    .prepare(
      `SELECT content FROM chapters WHERE project_id = ?
       ORDER BY sort_order DESC, created_at DESC LIMIT 1`,
    )
    .get(projectId) as { content: string } | undefined;
  return row?.content ?? '';
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
  beats?: string;
  /** 本章视角覆盖；null 表示继承项目默认 */
  pov?: Chapter['pov'];
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
    `INSERT INTO chapters (id, project_id, volume_id, title, sort_order, outline, content, status, word_count, summary, beats, pov, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    input.beats ?? '',
    input.pov ?? '',
    ts,
    ts,
  );
  return getChapter(id)!;
}

export function updateChapter(
  id: ID,
  patch: Partial<ChapterInput>,
  opts: { snapshotReason?: string; forceSnapshot?: boolean } = {},
): Chapter | null {
  const cur = getChapter(id);
  if (!cur) return null;
  const db = getDb();
  const content = patch.content ?? cur.content;
  const nextTitle = patch.title ?? cur.title;
  const nextOutline = patch.outline ?? cur.outline;
  const nextBeats = patch.beats ?? cur.beats ?? '';

  const changed =
    content !== cur.content ||
    nextTitle !== cur.title ||
    nextOutline !== cur.outline ||
    nextBeats !== (cur.beats ?? '');
  // 先留旧版本再覆盖：AI 写崩/误操作后还能从历史里找回来
  if (changed) snapshotChapter(cur, opts.snapshotReason ?? 'autosave', opts.forceSnapshot ?? false);

  db.prepare(
    `UPDATE chapters SET volume_id=?, title=?, outline=?, content=?, status=?, word_count=?, beats=?, pov=?, updated_at=? WHERE id=?`,
  ).run(
    patch.volumeId === undefined ? cur.volumeId : patch.volumeId,
    nextTitle,
    nextOutline,
    content,
    patch.status ?? cur.status,
    countWords(content),
    nextBeats,
    patch.pov === undefined ? (cur.pov ?? '') : (patch.pov ?? ''),
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

/**
 * 写入本章的事实核查单（核查点 + 引用片段）。
 * 引用片段也落库，刷新页面后仍能看到“这条结论出自哪份资料”。
 */
export function setChapterFacts(
  id: ID,
  facts: FactPoint[],
  extra: { hits?: FactSheet['hits']; generatedAt?: string } = {},
): void {
  const points = facts.slice(0, 20);
  const sheet: FactSheet = {
    points,
    hits: extra.hits ?? [],
    generatedAt: extra.generatedAt ?? nowIso(),
  };
  getDb()
    .prepare('UPDATE chapters SET facts=?, fact_sheet=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(points), JSON.stringify(sheet), nowIso(), id);
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
