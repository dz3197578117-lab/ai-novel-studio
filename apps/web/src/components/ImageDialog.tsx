import { useState } from 'react';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';

/** 封面/插图生成 */
export function ImageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useNovel((s) => s.project);
  const chapter = useNovel((s) => s.currentChapter);
  const images = useNovel((s) => s.images);
  const refresh = useNovel((s) => s.refresh);
  const setError = useNovel((s) => s.setError);

  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'cover' | 'illustration'>('cover');
  const [busy, setBusy] = useState(false);

  if (!project) return null;
  const mine = images.filter((i) => i.kind === kind);

  async function generate() {
    if (!project || !prompt.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project.id}/images`, {
        prompt: prompt.trim(),
        kind,
        chapterId: kind === 'illustration' ? (chapter?.id ?? null) : null,
        size: '1024x1024',
      });
      setPrompt('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="AI 配图">
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={kind === 'cover' ? 'primary' : ''} style={{ flex: 1 }} onClick={() => setKind('cover')}>
          封面
        </button>
        <button
          className={kind === 'illustration' ? 'primary' : ''}
          style={{ flex: 1 }}
          onClick={() => setKind('illustration')}
        >
          插图
        </button>
      </div>

      <div className="field">
        <label>画面描述</label>
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="例：雪夜，破旧祠堂，少年持残剑跪地，冷蓝色调，中式水墨感"
        />
      </div>

      <button className="primary" style={{ width: '100%' }} onClick={generate} disabled={busy || !prompt.trim()}>
        {busy ? '生成中…（可能需要 10-30 秒）' : '生成图片'}
      </button>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 8,
          marginTop: 16,
          maxHeight: 320,
          overflowY: 'auto',
        }}
      >
        {mine.map((img) => (
          <div key={img.id} style={{ position: 'relative' }}>
            <img
              src={img.url}
              alt={img.prompt}
              title={img.prompt}
              style={{ width: '100%', borderRadius: 6, display: 'block' }}
            />
            <button
              className="danger"
              style={{ position: 'absolute', top: 4, right: 4, padding: '1px 7px', background: 'rgba(0,0,0,.6)' }}
              onClick={async () => {
                await api.del(`/api/images/${img.id}`).catch(() => {});
                await refresh();
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {mine.length === 0 && <div className="empty">还没有生成过{kind === 'cover' ? '封面' : '插图'}</div>}
    </Modal>
  );
}
