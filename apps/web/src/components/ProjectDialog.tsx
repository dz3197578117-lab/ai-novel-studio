import { useEffect, useState } from 'react';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';
import type { NarrativePov, Project } from '@novelforge/shared';

const POV_OPTIONS: { value: NarrativePov; label: string }[] = [
  { value: 'auto', label: '未指定（沿用文风描述）' },
  { value: 'first', label: '第一人称限知（我）' },
  { value: 'third-limited', label: '第三人称限知（跟一个角色）' },
  { value: 'third-omniscient', label: '第三人称全知' },
  { value: 'multi', label: '多视角轮换' },
];

const POV_HINT: Record<NarrativePov, string> = {
  auto: '不额外注入视角规则，AI 按文风与已有正文推断。',
  first: '只写「我」的所见所感，不写他人心理，不写「我」不在场的场景。',
  'third-limited': '每章只跟一个视角人物，不跳到别人心里。可在这里写明跟谁。',
  'third-omniscient': '叙述者可进入任何角色内心，但不得提前泄底。',
  multi: '按章或按节切换视角，场景内不跳。可在这里写明切换规则。',
};

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
  const [pov, setPov] = useState<NarrativePov>('auto');
  const [povNote, setPovNote] = useState('');
  const [busy, setBusy] = useState(false);
  const loadProjects = useNovel((s) => s.loadProjects);
  const selectProject = useNovel((s) => s.selectProject);

  useEffect(() => {
    if (open) {
      setTitle(project?.title ?? '');
      setLogline(project?.logline ?? '');
      setGenre(project?.genre ?? '');
      setStyleGuide(project?.styleGuide ?? '');
      setPov(project?.pov ?? 'auto');
      setPovNote(project?.povNote ?? '');
    }
  }, [open, project]);

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const body = { title: title.trim(), logline, genre, styleGuide, pov, povNote };
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
        <label>叙述视角（写入每次生成的硬规则）</label>
        <select
          value={pov}
          onChange={(e) => setPov(e.target.value as NarrativePov)}
          style={{ width: '100%' }}
        >
          {POV_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="hint" style={{ marginTop: 4 }}>
          {POV_HINT[pov]}
        </div>
      </div>

      {pov !== 'auto' && (
        <div className="field">
          <label>视角补充规则（可选）</label>
          <input
            value={povNote}
            onChange={(e) => setPovNote(e.target.value)}
            placeholder={
              pov === 'multi'
                ? '例：按章切换；单章内不换视角；切换时另起一节并标出人物名'
                : pov === 'third-limited'
                  ? '例：视角人物为林尘；配角场景只通过林尘的观察带出'
                  : '例：全书不出现第二人称；回忆段落仍用第一人称'
            }
          />
        </div>
      )}

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
