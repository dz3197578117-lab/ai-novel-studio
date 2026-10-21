import type { Chapter, ChapterVersion, ChapterVersionSummary, ID } from '@novelforge/shared';
import { countWords, getDb, newId, nowIso } from '../db.js';

/**
 * 章节版本历史。
 *
 * 自动保存每 1.2 秒一次，不能每次都存一份全文，否则一章能堆出上万个快照。
 * 策略：
 * - 内容完全相同 → 跳过
 * - 自动保存 → 5 分钟内只留一份（同一段写作的起点）
 * - 手动保存 / AI 整章替换 / 恢复 → 强制留档（这些是最需要找回原稿的时刻）
 * - 每章最多保留 40 份
 */
const THROTTLE_MS = 5 * 60 * 1000;
const MAX_PER_CHAPTER = 40;

interface VersionRow {
  id: string;
  chapter_id: string;
  project_id: string;
  title: string;
  content: string;
  outline: string;
  beats: string;
  word_count: number;
  reason: string;
  created_at: string;
}

function toSummary(r: VersionRow): ChapterVersionSummary {
  return {
    id: r.id,
    chapterId: r.chapter_id,
    title: r.title,
    wordCount: r.word_count,
    reason: r.reason,
    excerpt: r.content.replace(/\s+/g, ' ').slice(0, 120),
    createdAt: r.created_at,
  };
}

function toFull(r: VersionRow): ChapterVersion {
  return {
    ...toSummary(r),
    content: r.content,
    outline: r.outline,
    beats: r.beats,
  };
}

/** 保存当前章节状态为一份快照（在更新之前调用） */
export function snapshotChapter(chapter: Chapter, reason: string, force = false): void {
  const db = getDb();
  const last = db
    .prepare(
      `SELECT content, title, outline, beats, created_at FROM chapter_versions
       WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chapter.id) as
    | { content: string; title: string; outline: string; beats: string; created_at: string }
    | undefined;

  if (
    last &&
    last.content === chapter.content &&
    last.title === chapter.title &&
    last.outline === chapter.outline &&
    last.beats === (chapter.beats ?? '')
  ) {
    return;
  }

  if (!force && reason === 'autosave' && last) {
    const age = Date.now() - Date.parse(last.created_at);
    if (Number.isFinite(age) && age < THROTTLE_MS) return;
  }

  db.prepare(
    `INSERT INTO chapter_versions
       (id, chapter_id, project_id, title, content, outline, beats, word_count, reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId(),
    chapter.id,
    chapter.projectId,
    chapter.title,
    chapter.content,
    chapter.outline,
    chapter.beats ?? '',
    countWords(chapter.content),
    reason,
    nowIso(),
  );

  // 只保留最近 N 份，避免长章节把库撑大
  db.prepare(
    `DELETE FROM chapter_versions
     WHERE chapter_id = ?
       AND id NOT IN (
         SELECT id FROM chapter_versions WHERE chapter_id = ?
         ORDER BY created_at DESC LIMIT ?
       )`,
  ).run(chapter.id, chapter.id, MAX_PER_CHAPTER);
}

export function listChapterVersions(chapterId: ID, limit = 30): ChapterVersionSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chapter_versions WHERE chapter_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chapterId, Math.max(1, Math.min(100, limit))) as unknown as VersionRow[];
  return rows.map(toSummary);
}

export function getChapterVersion(id: ID, chapterId?: ID): ChapterVersion | null {
  const row = chapterId
    ? (getDb()
        .prepare('SELECT * FROM chapter_versions WHERE id = ? AND chapter_id = ?')
        .get(id, chapterId) as VersionRow | undefined)
    : (getDb().prepare('SELECT * FROM chapter_versions WHERE id = ?').get(id) as
        | VersionRow
        | undefined);
  return row ? toFull(row) : null;
}
