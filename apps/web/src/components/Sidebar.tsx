import { useMemo, useState } from 'react';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import type { Chapter, ChapterSummary, Project } from '@novelforge/shared';

/** 左侧：作品切换 + 卷章树 */
export function Sidebar({ onNewProject, onEditProject }: {
  onNewProject: () => void;
  onEditProject: () => void;
}) {
  const projects = useNovel((s) => s.projects);
  const project = useNovel((s) => s.project);
  const volumes = useNovel((s) => s.volumes);
  const chapters = useNovel((s) => s.chapters);
  const currentChapter = useNovel((s) => s.currentChapter);
  const selectProject = useNovel((s) => s.selectProject);
  const loadChapter = useNovel((s) => s.loadChapter);
  const refresh = useNovel((s) => s.refresh);
  const [addingChapter, setAddingChapter] = useState(false);

  const grouped = useMemo(() => {
    const byVolume = new Map<string, ChapterSummary[]>();
    const orphan: ChapterSummary[] = [];
    for (const c of chapters) {
      if (c.volumeId) {
        const arr = byVolume.get(c.volumeId) ?? [];
        arr.push(c);
        byVolume.set(c.volumeId, arr);
      } else {
        orphan.push(c);
      }
    }
    return { byVolume, orphan };
  }, [chapters]);

  async function addChapter(volumeId: string | null) {
    if (!project) return;
    setAddingChapter(true);
    try {
      const c = await api.post<Chapter>(`/api/projects/${project.id}/chapters`, {
        title: `第${chapters.length + 1}章`,
        volumeId,
      });
      await refresh();
      await loadChapter(c.id);
    } finally {
      setAddingChapter(false);
    }
  }

  async function addVolume() {
    if (!project) return;
    await api.post(`/api/projects/${project.id}/volumes`, {
      title: `第${volumes.length + 1}卷`,
    });
    await refresh();
  }

  const totalWords = chapters.reduce((s, c) => s + c.wordCount, 0);

  return (
    <aside className="sidebar">
      <div className="brand">
        NovelForge <small>AI 创作台</small>
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
            <button className="ghost" onClick={addVolume} title="新建卷">
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

        {volumes.map((v) => (
          <div key={v.id}>
            <div className="volume-label">{v.title}</div>
            {(grouped.byVolume.get(v.id) ?? []).map((c) => (
              <ChapterRow
                key={c.id}
                chapter={c}
                active={currentChapter?.id === c.id}
                onClick={() => loadChapter(c.id)}
              />
            ))}
            <button
              className="ghost"
              style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => addChapter(v.id)}
            >
              ＋ 本章节
            </button>
          </div>
        ))}

        {grouped.orphan.map((c) => (
          <ChapterRow
            key={c.id}
            chapter={c}
            active={currentChapter?.id === c.id}
            onClick={() => loadChapter(c.id)}
          />
        ))}

        {chapters.length === 0 && <div className="empty">还没有章节<br />点右上角「章＋」开始</div>}
      </div>
    </aside>
  );
}

function ChapterRow({
  chapter,
  active,
  onClick,
}: {
  chapter: ChapterSummary;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`chapter-item${active ? ' active' : ''}`} onClick={onClick}>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {chapter.title}
      </span>
      <span className="wc">{chapter.wordCount > 0 ? chapter.wordCount : '·'}</span>
    </div>
  );
}

export type { Project };
