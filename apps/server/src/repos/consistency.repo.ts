import type {
  Foreshadow,
  ForeshadowInput,
  ForeshadowStatus,
  ID,
  TimelineEvent,
  TimelineInput,
} from '@novelforge/shared';
import { getDb, newId, nowIso } from '../db.js';

// ───────────────────────── 伏笔 ─────────────────────────

interface ForeshadowRow {
  id: string;
  project_id: string;
  title: string;
  detail: string;
  planted_chapter_id: string | null;
  planned_chapter_id: string | null;
  recovered_chapter_id: string | null;
  status: ForeshadowStatus;
  importance: number;
  created_at: string;
  updated_at: string;
}

const toForeshadow = (r: ForeshadowRow): Foreshadow => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  detail: r.detail,
  plantedChapterId: r.planted_chapter_id,
  plannedChapterId: r.planned_chapter_id,
  recoveredChapterId: r.recovered_chapter_id,
  status: r.status,
  importance: r.importance,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listForeshadows(projectId: ID): Foreshadow[] {
  const rows = getDb()
    .prepare('SELECT * FROM foreshadows WHERE project_id = ? ORDER BY importance DESC, created_at')
    .all(projectId) as unknown as ForeshadowRow[];
  return rows.map(toForeshadow);
}

/** 未回收的伏笔，用于注入生成上下文 */
export function listOpenForeshadows(projectId: ID, limit = 15): Foreshadow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM foreshadows WHERE project_id = ? AND status = 'planted'
       ORDER BY importance DESC, created_at LIMIT ?`,
    )
    .all(projectId, limit) as unknown as ForeshadowRow[];
  return rows.map(toForeshadow);
}

export function createForeshadow(projectId: ID, input: ForeshadowInput): Foreshadow {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO foreshadows (id, project_id, title, detail, planted_chapter_id, planned_chapter_id,
      recovered_chapter_id, status, importance, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    projectId,
    input.title,
    input.detail ?? '',
    input.plantedChapterId ?? null,
    input.plannedChapterId ?? null,
    input.recoveredChapterId ?? null,
    input.status ?? 'planted',
    input.importance ?? 2,
    ts,
    ts,
  );
  return getForeshadow(id)!;
}

export function getForeshadow(id: ID): Foreshadow | null {
  const row = getDb().prepare('SELECT * FROM foreshadows WHERE id = ?').get(id) as
    | ForeshadowRow
    | undefined;
  return row ? toForeshadow(row) : null;
}

export function updateForeshadow(
  id: ID,
  patch: Partial<ForeshadowInput>,
): Foreshadow | null {
  const cur = getForeshadow(id);
  if (!cur) return null;
  getDb()
    .prepare(
      `UPDATE foreshadows SET title=?, detail=?, planted_chapter_id=?, planned_chapter_id=?,
        recovered_chapter_id=?, status=?, importance=?, updated_at=? WHERE id=?`,
    )
    .run(
      patch.title ?? cur.title,
      patch.detail ?? cur.detail,
      patch.plantedChapterId === undefined ? cur.plantedChapterId : patch.plantedChapterId,
      patch.plannedChapterId === undefined ? cur.plannedChapterId : patch.plannedChapterId,
      patch.recoveredChapterId === undefined
        ? cur.recoveredChapterId
        : patch.recoveredChapterId,
      patch.status ?? cur.status,
      patch.importance ?? cur.importance,
      nowIso(),
      id,
    );
  return getForeshadow(id);
}

export function deleteForeshadow(id: ID): boolean {
  const res = getDb().prepare('DELETE FROM foreshadows WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

// ───────────────────────── 时间线 ─────────────────────────

interface TimelineRow {
  id: string;
  project_id: string;
  story_time: string;
  title: string;
  detail: string;
  chapter_id: string | null;
  importance: number;
  created_at: string;
  updated_at: string;
}

const toEvent = (r: TimelineRow): TimelineEvent => ({
  id: r.id,
  projectId: r.project_id,
  storyTime: r.story_time,
  title: r.title,
  detail: r.detail,
  chapterId: r.chapter_id,
  importance: r.importance,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listTimeline(projectId: ID): TimelineEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT t.*, c.sort_order AS chapter_order
       FROM timeline_events t LEFT JOIN chapters c ON c.id = t.chapter_id
       WHERE t.project_id = ?
       ORDER BY COALESCE(c.sort_order, 9999), t.story_time, t.created_at`,
    )
    .all(projectId) as unknown as TimelineRow[];
  return rows.map(toEvent);
}

export function createTimelineEvent(projectId: ID, input: TimelineInput): TimelineEvent {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO timeline_events (id, project_id, story_time, title, detail, chapter_id, importance, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    projectId,
    input.storyTime ?? '',
    input.title,
    input.detail ?? '',
    input.chapterId ?? null,
    input.importance ?? 2,
    ts,
    ts,
  );
  return getTimelineEvent(id)!;
}

export function getTimelineEvent(id: ID): TimelineEvent | null {
  const row = getDb().prepare('SELECT * FROM timeline_events WHERE id = ?').get(id) as
    | TimelineRow
    | undefined;
  return row ? toEvent(row) : null;
}

export function updateTimelineEvent(
  id: ID,
  patch: Partial<TimelineInput>,
): TimelineEvent | null {
  const cur = getTimelineEvent(id);
  if (!cur) return null;
  getDb()
    .prepare(
      `UPDATE timeline_events SET story_time=?, title=?, detail=?, chapter_id=?, importance=?, updated_at=? WHERE id=?`,
    )
    .run(
      patch.storyTime ?? cur.storyTime,
      patch.title ?? cur.title,
      patch.detail ?? cur.detail,
      patch.chapterId === undefined ? cur.chapterId : patch.chapterId,
      patch.importance ?? cur.importance,
      nowIso(),
      id,
    );
  return getTimelineEvent(id);
}

export function deleteTimelineEvent(id: ID): boolean {
  const res = getDb().prepare('DELETE FROM timeline_events WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}
