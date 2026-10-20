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
  first: '场景内只写「我」的所见所感。换章、分节、时空跳转时仍可按下面的规则切视角。',
  'third-limited': '场景内只跟一个视角人物，不跳到别人心里。换章或分节时可以换人，规则写在下面。',
  'third-omniscient': '叙述者可进入任何角色内心，但不得提前泄底。',
  multi: '每个场景一个视角人物；切换靠分节标记让人认出来。',
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
  const setError = useNovel((s) => s.setError);

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
    } catch (e) {
      // 以前没有 catch：接口失败时对话框静默无反应，控制台只留一个未处理的 Promise
      setError((e as Error).message);
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
        <label>默认叙述视角（单个场景内保持，不是全书唯一）</label>
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
          <label>允许的视角切换（可选，一行一条）</label>
          <textarea
            rows={3}
            value={povNote}
            onChange={(e) => setPovNote(e.target.value)}
            placeholder={
              '例：每卷最后一章切到反派视角，另起一节并以人名开头\n例：亲密场景结束后可切到另一方，用空行分节\n例：插入书信、审讯记录时可直接换载体'
            }
          />
          <div className="hint" style={{ marginTop: 4 }}>
            不填则默认只在换章、分节、时空跳转时允许切换。无论怎么切，都要有让人认得出的标记。
          </div>
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
