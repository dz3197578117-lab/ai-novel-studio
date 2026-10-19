import { useState } from 'react';
import type { NovelDraft, Project } from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';

const CHAPTER_OPTIONS = [6, 10, 15, 20, 30];

/** 章数允许范围，与后端一致 */
const MIN_CHAPTERS = 1;
const MAX_CHAPTERS = 100;

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.max(MIN_CHAPTERS, Math.min(MAX_CHAPTERS, Math.floor(n)));
}

const TYPE_LABEL: Record<string, string> = {
  world: '世界观',
  character: '人物',
  faction: '势力',
  term: '名词',
  item: '物品',
  location: '地点',
};

/**
 * 让 AI 根据需求直接策划一部小说：
 * 输入想法 → 生成方案（书名/简介/设定/卷章大纲）→ 预览确认 → 一键建书。
 */
export function AiNovelDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** 创建成功后的回调，参数是新作品 id */
  onCreated: (projectId: string) => void | Promise<void>;
}) {
  const setError = useNovel((s) => s.setError);

  const [idea, setIdea] = useState('');
  const [genre, setGenre] = useState('');
  /** 用字符串保存，允许用户自由输入；提交时再归一化 */
  const [chapterInput, setChapterInput] = useState('10');
  const [draft, setDraft] = useState<NovelDraft | null>(null);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  /** 本次生成时要求的章数，用于提示 AI 给的章数是否对得上 */
  const [requestedCount, setRequestedCount] = useState<number | null>(null);

  const chapterCount = clampCount(Number(chapterInput));

  function reset() {
    setDraft(null);
  }

  async function generate() {
    if (!idea.trim()) return;
    setGenerating(true);
    setDraft(null);
    setRequestedCount(chapterCount);
    try {
      const res = await api.post<{ draft: NovelDraft }>('/api/ai/draft', {
        idea: idea.trim(),
        genre: genre.trim() || undefined,
        chapterCount,
      });
      setDraft(res.draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function create() {
    if (!draft) return;
    setCreating(true);
    try {
      const res = await api.post<{ project: Project }>('/api/projects/from-draft', { draft });
      onClose();
      reset();
      setIdea('');
      await onCreated(res.project.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={draft ? '确认方案' : 'AI 生成小说'} wide>
      {!draft ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
            描述你想写的故事，AI 会给出书名、简介、人物设定和卷章大纲。生成后可以预览修改，确认了才会真正建书。
          </p>

          <div className="field">
            <label>你想要什么样的故事？</label>
            <textarea
              rows={5}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder={
                '例：一个被逐出家门的少年剑修，追查父亲失踪的真相，发现自己父亲其实是被冤枉的宗门叛徒。想写冷峻克制、偏传统的古典玄幻。'
              }
              autoFocus
            />
          </div>

          <div className="row">
            <div className="field" style={{ flex: 2 }}>
              <label>题材（可留空，让 AI 决定）</label>
              <input
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                placeholder="古典玄幻 / 都市悬疑 / 科幻末世…"
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>规划章数（可自己填）</label>
              <input
                type="number"
                min={1}
                max={100}
                value={chapterInput}
                onChange={(e) => setChapterInput(e.target.value)}
                onBlur={() => {
                  // 失焦时纠正到合法范围，避免空值/负数/超量
                  const n = clampCount(Number(chapterInput));
                  setChapterInput(String(n));
                }}
              />
              <div className="count-presets">
                {CHAPTER_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="count-chip"
                    onClick={() => setChapterInput(String(n))}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={onClose} disabled={generating}>
              取消
            </button>
            <button className="primary" onClick={generate} disabled={generating || !idea.trim()}>
              {generating ? '正在构思…' : '生成方案'}
            </button>
          </div>

          {generating && (
            <div className="empty" style={{ padding: '20px 0' }}>
              正在为你构思，通常需要 10–60 秒…
            </div>
          )}
        </>
      ) : (
        <>
          <div className="draft-head">
            <div>
              <div className="draft-title">{draft.title}</div>
              <div className="draft-sub">
                {draft.genre || '未分类'} · {draft.volumes.length} 卷 · {draft.chapters.length} 章
                {requestedCount && draft.chapters.length !== requestedCount && (
                  <span className="draft-warn">
                    （你要求 {requestedCount} 章，AI 给了 {draft.chapters.length} 章）
                  </span>
                )}
              </div>
            </div>
          </div>

          {draft.logline && <div className="draft-logline">{draft.logline}</div>}

          {draft.styleGuide && (
            <div className="field">
              <label>文风要求</label>
              <div className="draft-block">{draft.styleGuide}</div>
            </div>
          )}

          {draft.entities.length > 0 && (
            <div className="field">
              <label>设定的 {draft.entities.length} 个条目</label>
              <div className="draft-entities">
                {draft.entities.map((e, i) => (
                  <div className="draft-entity" key={`${e.name}-${i}`}>
                    <span className="tag">{TYPE_LABEL[e.type] ?? e.type}</span>
                    <span className="draft-entity-name">{e.name}</span>
                    {e.pinned && <span className="pin">固定</span>}
                    <div className="summary">{e.summary}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <label>卷章大纲</label>
            <div className="draft-outline">
              {draft.volumes.map((v, vi) => (
                <div key={`${v.title}-${vi}`}>
                  <div className="draft-volume">{v.title}</div>
                  {draft.chapters
                    .filter((c) => c.volumeIndex === vi)
                    .map((c, ci) => (
                      <div className="draft-chapter" key={`${c.title}-${ci}`}>
                        <div className="draft-chapter-title">{c.title}</div>
                        <div className="summary">{c.outline}</div>
                      </div>
                    ))}
                </div>
              ))}
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={reset} disabled={creating}>
              ← 改需求重生成
            </button>
            <button className="primary" onClick={create} disabled={creating}>
              {creating ? '创建中…' : '创建这本书'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
