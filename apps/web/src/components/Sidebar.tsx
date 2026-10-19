import { useMemo, useState } from 'react';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import type { Chapter, ChapterSummary, Project } from '@novelforge/shared';

type RenameTarget = { kind: 'chapter' | 'volume'; id: string } | null;

/** 左侧：作品切换 + 卷章树（支持重命名与删除） */
export function Sidebar({
  onNewProject,
  onEditProject,
  onBackToShelf,
}: {
  onNewProject: () => void;
  onEditProject: () => void;
  onBackToShelf: () => void;
}) {
  const projects = useNovel((s) => s.projects);
  const project = useNovel((s) => s.project);
  const volumes = useNovel((s) => s.volumes);
  const chapters = useNovel((s) => s.chapters);
  const currentChapter = useNovel((s) => s.currentChapter);
  const selectProject = useNovel((s) => s.selectProject);
  const loadChapter = useNovel((s) => s.loadChapter);
  const clearChapter = useNovel((s) => s.clearChapter);
  const refresh = useNovel((s) => s.refresh);
  const setError = useNovel((s) => s.setError);

  const [addingChapter, setAddingChapter] = useState(false);
  const [renaming, setRenaming] = useState<RenameTarget>(null);
  const [renameValue, setRenameValue] = useState('');
  /** 多选批量操作（千章规模下逐条删太痛苦） */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [moveTarget, setMoveTarget] = useState('');

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  /** 过滤后的章节（按标题 / 大纲关键字） */
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return chapters;
    return chapters.filter((c) => c.title.toLowerCase().includes(q));
  }, [chapters, filter]);

  const grouped = useMemo(() => {
    const byVolume = new Map<string, ChapterSummary[]>();
    const orphan: ChapterSummary[] = [];
    for (const c of visible) {
      if (c.volumeId) {
        const arr = byVolume.get(c.volumeId) ?? [];
        arr.push(c);
        byVolume.set(c.volumeId, arr);
      } else {
        orphan.push(c);
      }
    }
    return { byVolume, orphan };
  }, [visible]);

  async function batchDelete() {
    if (!project || selected.size === 0) return;
    const words = chapters
      .filter((c) => selected.has(c.id))
      .reduce((s, c) => s + c.wordCount, 0);
    const ok = confirm(
      `确定删除选中的 ${selected.size} 个章节？\n\n` +
        (words > 0 ? `共 ${words} 字正文，` : '') +
        '删除后可在 data/backups/deleted-*.json 中找回。',
    );
    if (!ok) return;
    const ids = [...selected];
    try {
      const r = await api.post<{ deleted: number }>(
        `/api/projects/${project.id}/chapters/batch-delete`,
        { ids },
      );
      // 当前章节被删了就清空编辑区
      if (currentChapter && ids.includes(currentChapter.id)) clearChapter();
      exitSelect();
      await refresh();
      const rest = useNovel.getState().chapters;
      if (!useNovel.getState().currentChapter && rest.length > 0) {
        await loadChapter(rest[0]!.id);
      }
      setError(`已删除 ${r.deleted} 个章节`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function batchMove() {
    if (!project || selected.size === 0) return;
    try {
      const r = await api.post<{ moved: number }>(
        `/api/projects/${project.id}/chapters/batch-move`,
        { ids: [...selected], volumeId: moveTarget || null },
      );
      exitSelect();
      await refresh();
      setError(`已移动 ${r.moved} 个章节`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * 用「已有最大序号 + 1」而不是「章节数 + 1」，
   * 否则删过章节后新建会撞名（曾经出现过两个「第5章」）。
   */
  function nextChapterTitle(): string {
    const used = chapters
      .map((c) => /^第(\d+)章/.exec(c.title)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number);
    return `第${(used.length ? Math.max(...used) : chapters.length) + 1}章`;
  }

  function nextVolumeTitle(): string {
    const used = volumes
      .map((v) => /^第(\d+)卷/.exec(v.title)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number);
    return `第${(used.length ? Math.max(...used) : volumes.length) + 1}卷`;
  }

  function startRename(kind: 'chapter' | 'volume', id: string, current: string) {
    setRenaming({ kind, id });
    setRenameValue(current);
  }

  async function commitRename() {
    if (!renaming) return;
    const title = renameValue.trim();
    setRenaming(null);
    if (!title) return;
    try {
      if (renaming.kind === 'chapter') {
        await api.patch(`/api/chapters/${renaming.id}`, { title });
        if (currentChapter?.id === renaming.id) await loadChapter(renaming.id);
      } else {
        await api.patch(`/api/volumes/${renaming.id}`, { title });
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addChapter(volumeId: string | null) {
    if (!project) return;
    setAddingChapter(true);
    try {
      const c = await api.post<Chapter>(`/api/projects/${project.id}/chapters`, {
        title: nextChapterTitle(),
        volumeId,
      });
      await refresh();
      await loadChapter(c.id);
      // 新建后直接进入改名状态，省去再找一次
      startRename('chapter', c.id, c.title);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAddingChapter(false);
    }
  }

  async function addVolume() {
    if (!project) return;
    try {
      await api.post(`/api/projects/${project.id}/volumes`, { title: nextVolumeTitle() });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeChapter(c: ChapterSummary) {
    const hasText = c.wordCount > 0;
    const ok = confirm(
      hasText
        ? `删除「${c.title}」？\n\n该章有 ${c.wordCount} 字正文，删除后不可恢复。`
        : `删除「${c.title}」？`,
    );
    if (!ok) return;
    try {
      await api.del(`/api/chapters/${c.id}`);
      const wasCurrent = currentChapter?.id === c.id;
      if (wasCurrent) clearChapter();
      await refresh();
      if (wasCurrent) {
        const rest = useNovel.getState().chapters;
        if (rest.length > 0) await loadChapter(rest[0]!.id);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeVolume(volumeId: string, title: string, chapterCount: number) {
    const ok = confirm(
      chapterCount > 0
        ? `删除「${title}」？\n\n该卷下的 ${chapterCount} 个章节会保留，但不再归属任何卷。`
        : `删除「${title}」？`,
    );
    if (!ok) return;
    try {
      await api.del(`/api/volumes/${volumeId}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const totalWords = chapters.reduce((s, c) => s + c.wordCount, 0);

  return (
    <aside className="sidebar">
      <div className="brand brand-clickable" onClick={onBackToShelf} title="返回书架">
        <span>←</span> NovelForge <small>AI 创作台</small>
      </div>

      <div className="section">
        <div className="section-title">
          <span>作品</span>
          <button className="ghost" onClick={onNewProject} title="新建作品">
            ＋
          </button>
        </div>
        <select
          value={project?.id ?? ''}
          onChange={(e) => e.target.value && selectProject(e.target.value)}
        >
          {projects.length === 0 && <option value="">尚无作品</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        {project && (
          <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
            <button className="ghost" style={{ flex: 1 }} onClick={onEditProject}>
              编辑信息
            </button>
          </div>
        )}
        {project && (
          <div className="summary" style={{ marginTop: 8 }}>
            共 {chapters.length} 章 · {totalWords.toLocaleString()} 字
          </div>
        )}
      </div>

      <div className="section" style={{ flex: 1 }}>
        <div className="section-title">
          <span>目录</span>
          <span style={{ display: 'flex', gap: 2 }}>
            {chapters.length > 0 && (
              <button
                className={`ghost${selectMode ? ' on' : ''}`}
                onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
                title="多选：批量删除 / 移动章节"
              >
                多选
              </button>
            )}
            <button className="ghost" onClick={addVolume} disabled={!project} title="新建卷">
              卷＋
            </button>
            <button
              className="ghost"
              onClick={() => addChapter(null)}
              disabled={addingChapter || !project}
              title="新建章节"
            >
              章＋
            </button>
          </span>
        </div>

        {chapters.length > 8 && (
          <input
            className="rename-input"
            style={{ marginBottom: 6 }}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索章节标题…"
          />
        )}

        {selectMode && (
          <div className="batch-bar">
            <div className="batch-info">
              已选 {selected.size} / {visible.length}
              <button
                className="link-btn"
                onClick={() =>
                  setSelected((prev) => {
                    if (prev.size === visible.length) return new Set();
                    return new Set(visible.map((c) => c.id));
                  })
                }
              >
                {selected.size === visible.length ? '取消全选' : '全选'}
              </button>
            </div>
            <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)}>
              <option value="">移到…（不选=移出卷）</option>
              {volumes.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                style={{ padding: '3px 8px', fontSize: 11 }}
                disabled={selected.size === 0}
                onClick={() => void batchMove()}
              >
                移动
              </button>
              <button
                className="danger"
                style={{ padding: '3px 8px', fontSize: 11 }}
                disabled={selected.size === 0}
                onClick={() => void batchDelete()}
              >
                删除
              </button>
            </div>
          </div>
        )}

        {volumes.map((v) => {
          const list = grouped.byVolume.get(v.id) ?? [];
          if (filter && list.length === 0) return null;
          const isRenamingVolume = renaming?.kind === 'volume' && renaming.id === v.id;
          return (
            <div key={v.id} className="volume-block">
              {isRenamingVolume ? (
                <input
                  className="rename-input"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <div className="volume-label">
                  <span
                    className="volume-name"
                    onDoubleClick={() => startRename('volume', v.id, v.title)}
                    title="双击重命名"
                  >
                    {v.title}
                  </span>
                  <span className="row-actions">
                    <button
                      className="icon-btn"
                      title="重命名本卷"
                      onClick={() => startRename('volume', v.id, v.title)}
                    >
                      ✎
                    </button>
                    <button
                      className="icon-btn danger"
                      title="删除本卷（章节保留）"
                      onClick={() => void removeVolume(v.id, v.title, list.length)}
                    >
                      ×
                    </button>
                  </span>
                </div>
              )}

              {list.map((c) => (
                <ChapterRow
                  key={c.id}
                  chapter={c}
                  active={currentChapter?.id === c.id}
                  selectMode={selectMode}
                  checked={selected.has(c.id)}
                  onToggle={() => toggleSelect(c.id)}
                  renaming={renaming?.kind === 'chapter' && renaming.id === c.id}
                  renameValue={renameValue}
                  onRenameChange={setRenameValue}
                  onRenameCommit={() => void commitRename()}
                  onRenameCancel={() => setRenaming(null)}
                  onClick={() => void loadChapter(c.id)}
                  onStartRename={() => startRename('chapter', c.id, c.title)}
                  onDelete={() => void removeChapter(c)}
                />
              ))}

              <button
                className="ghost add-sub"
                onClick={() => void addChapter(v.id)}
                disabled={addingChapter}
              >
                ＋ 本章节
              </button>
            </div>
          );
        })}

        {grouped.orphan.map((c) => (
          <ChapterRow
            key={c.id}
            chapter={c}
            active={currentChapter?.id === c.id}
            selectMode={selectMode}
            checked={selected.has(c.id)}
            onToggle={() => toggleSelect(c.id)}
            renaming={renaming?.kind === 'chapter' && renaming.id === c.id}
            renameValue={renameValue}
            onRenameChange={setRenameValue}
            onRenameCommit={() => void commitRename()}
            onRenameCancel={() => setRenaming(null)}
            onClick={() => void loadChapter(c.id)}
            onStartRename={() => startRename('chapter', c.id, c.title)}
            onDelete={() => void removeChapter(c)}
          />
        ))}

        {chapters.length > 0 && visible.length === 0 && (
          <div className="empty">没有匹配「{filter}」的章节</div>
        )}

        {chapters.length === 0 && (
          <div className="empty">
            还没有章节
            <br />
            点右上角「章＋」开始
          </div>
        )}
      </div>
    </aside>
  );
}

function ChapterRow({
  chapter,
  active,
  selectMode,
  checked,
  onToggle,
  renaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onClick,
  onStartRename,
  onDelete,
}: {
  chapter: ChapterSummary;
  active: boolean;
  selectMode: boolean;
  checked: boolean;
  onToggle: () => void;
  renaming: boolean;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onClick: () => void;
  onStartRename: () => void;
  onDelete: () => void;
}) {
  if (renaming) {
    return (
      <div className="chapter-item editing">
        <input
          className="rename-input"
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameCommit();
            if (e.key === 'Escape') onRenameCancel();
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`chapter-item${active ? ' active' : ''}${checked ? ' checked' : ''}`}
      onClick={() => (selectMode ? onToggle() : onClick())}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!selectMode) onStartRename();
      }}
      title={selectMode ? '点击勾选' : '双击重命名'}
    >
      {selectMode && (
        <input
          type="checkbox"
          className="chapter-check"
          checked={checked}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <span className="chapter-name">{chapter.title}</span>
      {!selectMode && (
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="重命名" onClick={onStartRename}>
            ✎
          </button>
          <button className="icon-btn danger" title="删除章节" onClick={onDelete}>
            ×
          </button>
        </span>
      )}
      <span className="wc">{chapter.wordCount > 0 ? chapter.wordCount : '·'}</span>
    </div>
  );
}

export type { Project };
