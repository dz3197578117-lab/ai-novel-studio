/**
 * 生成 / 修复演示作品。
 *
 * 首次运行：创建完整演示作品。
 * 再次运行：只补齐缺失的设定、卷、章节，不会覆盖你写过的内容。
 *
 * 运行：pnpm seed
 */
import { createProject, listProjects, updateProject } from '../repos/projects.repo.js';
import { createEntity, listEntities } from '../repos/entities.repo.js';
import {
  createChapter,
  createVolume,
  listChapters,
  listVolumes,
  setChapterSummary,
  updateChapter,
} from '../repos/chapters.repo.js';
import { getDb } from '../db.js';
import {
  DEMO_CHAPTERS,
  DEMO_ENTITIES,
  DEMO_PROJECT,
  DEMO_TITLE,
  DEMO_VOLUMES,
} from './demo-data.js';

function main() {
  getDb();

  const existing = listProjects().find((p) => p.title === DEMO_TITLE);
  if (!existing) {
    createAll();
    return;
  }

  console.log(`演示作品已存在：${existing.id}`);
  backfill(existing.id);
}

function createAll(): void {
  const project = createProject(DEMO_PROJECT);
  updateProject(project.id, { status: 'drafting' });
  backfill(project.id);
  console.log(`\n演示作品「${DEMO_TITLE}」已创建：${project.id}`);
}

/**
 * 只补缺失项：按名称/标题比对，已存在的一律不动，
 * 这样即使你改过或删过，也能安全地再跑一次。
 */
function backfill(projectId: string): void {
  let added = 0;

  const existingEntities = new Set(listEntities(projectId).map((e) => e.name));
  for (const e of DEMO_ENTITIES) {
    if (existingEntities.has(e.name)) continue;
    createEntity(projectId, {
      type: e.type,
      name: e.name,
      aliases: e.aliases,
      summary: e.summary,
      fields: e.fields,
      body: e.body,
      pinned: e.pinned,
    });
    console.log(`  ＋ 设定：${e.name}`);
    added++;
  }

  const volumeIdByIndex = new Map<number, string>();
  const existingVolumes = listVolumes(projectId);
  DEMO_VOLUMES.forEach((v, idx) => {
    const found = existingVolumes.find((x) => x.title === v.title);
    if (found) {
      volumeIdByIndex.set(idx, found.id);
    } else {
      const created = createVolume(projectId, v.title, v.summary);
      volumeIdByIndex.set(idx, created.id);
      console.log(`  ＋ 卷：${v.title}`);
      added++;
    }
  });

  const existingChapters = new Set(listChapters(projectId).map((c) => c.title));
  for (const c of DEMO_CHAPTERS) {
    if (existingChapters.has(c.title)) continue;
    const created = createChapter(projectId, {
      title: c.title,
      volumeId: c.volumeIndex === null ? null : (volumeIdByIndex.get(c.volumeIndex) ?? null),
      outline: c.outline,
      content: c.content,
      status: c.status,
    });
    // 摘要要单独写，createChapter 不接受 summary 字段
    if (c.summary) {
      setChapterSummary(created.id, c.summary);
    }
    console.log(`  ＋ 章节：${c.title}`);
    added++;
  }

  console.log(added === 0 ? '数据完整，无需补充。' : `\n已补齐 ${added} 项。`);
}

main();
