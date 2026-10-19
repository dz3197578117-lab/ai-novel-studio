import { useEffect, useState } from 'react';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';
import type { Project } from '@novelforge/shared';

/** 新建/编辑作品 */
export function ProjectDialog({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project | null;
  /** 保存成功后回调，作品库用它刷新列表 */
  onSaved?: () => void | Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [logline, setLogline] = useState('');
  const [genre, setGenre] = useState('');
  const [styleGuide, setStyleGuide] = useState('');
  const [busy, setBusy] = useState(false);
  const loadProjects = useNovel((s) => s.loadProjects);
  const selectProject = useNovel((s) => s.selectProject);

  useEffect(() => {
    if (open) {
      setTitle(project?.title ?? '');
      setLogline(project?.logline ?? '');
      setGenre(project?.genre ?? '');
      setStyleGuide(project?.styleGuide ?? '');
    }
  }, [open, project]);

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const body = { title: title.trim(), logline, genre, styleGuide };
      if (project) {
        await api.patch(`/api/projects/${project.id}`, body);
        await selectProject(project.id);
      } else {
        const created = await api.post<Project>('/api/projects', body);
        await loadProjects();
        await selectProject(created.id);
      }
      await onSaved?.();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={project ? '编辑作品' : '新建作品'}>
      <div className="field">
        <label>书名</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：长夜将明" autoFocus />
      </div>
      <div className="field">
        <label>一句话简介</label>
        <input value={logline} onChange={(e) => setLogline(e.target.value)} placeholder="主角是谁，想要什么，阻力是什么" />
      </div>
      <div className="field">
        <label>题材</label>
        <input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="玄幻 / 都市 / 悬疑 …" />
      </div>
      <div className="field">
        <label>文风要求（每次生成都会注入）</label>
        <textarea
          rows={4}
          value={styleGuide}
          onChange={(e) => setStyleGuide(e.target.value)}
          placeholder="例：第三人称限知视角，冷峻克制的叙述，少用形容词，多写动作与细节。"
        />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={save} disabled={busy || !title.trim()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </Modal>
  );
}
