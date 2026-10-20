import { useEffect, useRef, useState } from 'react';
import type {
  DraftChapter,
  DraftEntity,
  InterviewReply,
  NovelDraft,
  Project,
} from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';

const CHAPTER_OPTIONS = [30, 100, 200, 500, 1000];
const MIN_CHAPTERS = 1;
const MAX_CHAPTERS = 1000;

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

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

const GREETING: Msg = {
  role: 'assistant',
  content:
    '想写一部什么样的小说？随便说一句就行，我来帮你把方向聊清楚。\n比如「一个被逐出宗门的剑修，追查父亲失踪的真相」。',
};

const STARTERS = ['古典玄幻', '都市悬疑', '科幻末世', '古代言情', '历史权谋'];

/**
 * 方案草稿：生成一次可能要跑几分钟，误关窗口不该白跑。
 * 存在本地，24 小时内重开还能接着改；建书或主动放弃时清掉。
 */
const DRAFT_KEY = 'novelforge:draft-preview';
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

function loadSavedDraft(): NovelDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { at?: number; draft?: NovelDraft };
    if (!o?.draft || Date.now() - (o.at ?? 0) > DRAFT_TTL_MS) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return o.draft;
  } catch {
    return null;
  }
}

function saveDraftLocal(d: NovelDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Date.now(), draft: d }));
  } catch {
    /* 配额满了就算了，不能因为缓存失败打断主流程 */
  }
}

function clearSavedDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * AI 生成小说：先对话聊需求，聊清楚再出方案，确认后建书。
 * 对话式的好处是不用一次想全，AI 会问你类型、主角、基调这些。
 */
export function AiNovelDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (projectId: string) => void | Promise<void>;
}) {
  const setError = useNovel((s) => s.setError);

  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState('');
  const [reply, setReply] = useState<InterviewReply | null>(null);
  const [thinking, setThinking] = useState(false);

  const [chapterInput, setChapterInput] = useState('10');
  const [draft, setDraft] = useState<NovelDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [requestedCount, setRequestedCount] = useState<number | null>(null);
  /** 正在重做第几章的大纲 */
  const [regenIndex, setRegenIndex] = useState<number | null>(null);
  /** 生成计时：章数多时要跑几分钟，让用户看得见还在动 */
  const [elapsed, setElapsed] = useState(0);
  /** 这份方案是从本地草稿恢复的 */
  const [restored, setRestored] = useState(false);

  const chatRef = useRef<HTMLDivElement | null>(null);

  // 打开时尝试恢复上次未建书的方案
  useEffect(() => {
    if (!open) return;
    setRestored(false);
    if (draft) return;
    const saved = loadSavedDraft();
    if (saved) {
      setDraft(saved);
      setRestored(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 方案有任何改动就落本地，避免误关丢失
  useEffect(() => {
    if (draft) saveDraftLocal(draft);
  }, [draft]);

  /** 改动方案里的字段（预览区全部可编辑） */
  function patch(p: Partial<NovelDraft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }
  function patchEntity(i: number, p: Partial<DraftEntity>) {
    setDraft((d) =>
      d ? { ...d, entities: d.entities.map((e, j) => (j === i ? { ...e, ...p } : e)) } : d,
    );
  }
  function removeEntity(i: number) {
    setDraft((d) => (d ? { ...d, entities: d.entities.filter((_, j) => j !== i) } : d));
  }
  function patchChapter(i: number, p: Partial<DraftChapter>) {
    setDraft((d) =>
      d ? { ...d, chapters: d.chapters.map((c, j) => (j === i ? { ...c, ...p } : c)) } : d,
    );
  }
  function removeChapter(i: number) {
    setDraft((d) => (d ? { ...d, chapters: d.chapters.filter((_, j) => j !== i) } : d));
  }
  function patchVolume(i: number, title: string) {
    setDraft((d) =>
      d ? { ...d, volumes: d.volumes.map((v, j) => (j === i ? { ...v, title } : v)) } : d,
    );
  }
  const chapterCount = clampCount(Number(chapterInput));

  // 每次打开都从新对话开始
  useEffect(() => {
    if (!open) return;
    setMessages([GREETING]);
    setInput('');
    setReply(null);
    setDraft(null);
    setRequestedCount(null);
    setThinking(false);
  }, [open]);

  // 新消息后滚到底部
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, reply]);

  // 生成期间的计时器
  useEffect(() => {
    if (!drafting) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [drafting]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || thinking) return;
    const next: Msg[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setThinking(true);
    setReply(null);
    try {
      const r = await api.post<InterviewReply>('/api/ai/interview', {
        messages: next.map((m) => ({ role: m.role, content: m.content })),
      });
      setMessages((prev) => [...prev, { role: 'assistant', content: r.say }]);
      setReply(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setThinking(false);
    }
  }

  /** 用聊出来的需求生成方案 */
  async function generateDraft() {
    const brief =
      reply?.done && reply.brief
        ? reply.brief
        : messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content)
            .join('；') || '写一部有吸引力的长篇小说';

    setDrafting(true);
    setRequestedCount(chapterCount);
    try {
      const res = await api.post<{ draft: NovelDraft }>('/api/ai/draft', {
        idea: brief,
        chapterCount,
      });
      setDraft(res.draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  /** 只重做某一章的大纲，其余不动 */
  async function regenChapter(index: number) {
    if (!draft) return;
    setRegenIndex(index);
    try {
      const res = await api.post<{ chapter: NovelDraft['chapters'][number] }>(
        '/api/ai/regenerate-chapter',
        {
          title: draft.title,
          logline: draft.logline,
          volumes: draft.volumes,
          chapters: draft.chapters,
          index,
        },
      );
      setDraft({
        ...draft,
        chapters: draft.chapters.map((c, i) =>
          // 保持原来的卷归属，只替换标题与大纲
          i === index ? { ...c, title: res.chapter.title, outline: res.chapter.outline } : c,
        ),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRegenIndex(null);
    }
  }

  async function create() {
    if (!draft) return;
    setCreating(true);
    try {
      const res = await api.post<{ project: Project }>('/api/projects/from-draft', { draft });
      clearSavedDraft();
      onClose();
      await onCreated(res.project.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const chatPhase = !draft;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={chatPhase ? 'AI 生成小说' : '确认方案'}
      wide
    >
      {chatPhase ? (
        <>
          <div className="chat-log" ref={chatRef}>
            {messages.map((m, i) => (
              <div key={i} className={`chat-bubble ${m.role}`}>
                {m.content}
              </div>
            ))}
            {thinking && <div className="chat-bubble assistant thinking">正在想…</div>}
          </div>

          {/* 首轮给类型快捷入口 */}
          {messages.length === 1 && (
            <div className="chat-options">
              {STARTERS.map((s) => (
                <button key={s} className="count-chip" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* AI 给出的追问选项 */}
          {reply && reply.options.length > 0 && !reply.done && (
            <div className="chat-options">
              {reply.options.map((o) => (
                <button key={o} className="count-chip" onClick={() => void send(o)}>
                  {o}
                </button>
              ))}
            </div>
          )}

          <div className="chat-composer">
            <input
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="说说你想写的故事，或回答上面的问题…"
              disabled={thinking}
            />
            <button onClick={() => void send(input)} disabled={thinking || !input.trim()}>
              发送
            </button>
          </div>

          <div className="chat-footer">
            <label className="chat-count">
              规划章数
              <input
                type="number"
                min={MIN_CHAPTERS}
                max={MAX_CHAPTERS}
                value={chapterInput}
                onChange={(e) => setChapterInput(e.target.value)}
                onBlur={() => setChapterInput(String(clampCount(Number(chapterInput))))}
              />
            </label>
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
            <div style={{ flex: 1 }} />
            <button
              className="primary"
              onClick={() => void generateDraft()}
              disabled={drafting || thinking}
              title={reply?.done ? '用聊好的需求生成方案' : '也可以跳过问答直接生成'}
            >
              {drafting ? '构思中…' : reply?.done ? '开始生成方案' : '直接生成'}
            </button>
          </div>

          {reply?.done && reply.brief && (
            <div className="brief-preview">
              <div className="brief-label">已整理出的需求</div>
              <div>{reply.brief}</div>
            </div>
          )}

          {drafting && (
            <div className="empty" style={{ padding: '10px 0' }}>
              已用 {elapsed} 秒 ·{' '}
              {chapterCount > 10
                ? `正在分批生成 ${chapterCount} 章${
                    chapterCount > 300 ? '（预计 10 分钟以上，可以先去泡杯茶）' : '（预计 1-3 分钟）'
                  }`
                : '正在构思方案（通常 10-60 秒）'}
            </div>
          )}
        </>
      ) : (
        <>
          {restored && (
            <div
              className="hint"
              style={{
                marginBottom: 8,
                padding: '6px 10px',
                borderRadius: 6,
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
              }}
            >
              已恢复上次未建书的方案。
              <button
                className="ghost"
                style={{ marginLeft: 8, padding: '0 6px', fontSize: 11 }}
                onClick={() => {
                  clearSavedDraft();
                  setDraft(null);
                  setRestored(false);
                }}
              >
                不要了，重新开始
              </button>
            </div>
          )}

          <div className="draft-head">
            <div style={{ flex: 1 }}>
              <input
                className="inline-edit draft-title-input"
                value={draft.title}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder="书名"
              />
              <div className="draft-sub">
                <input
                  className="inline-edit"
                  style={{ width: 90 }}
                  value={draft.genre}
                  onChange={(e) => patch({ genre: e.target.value })}
                  placeholder="题材"
                />
                {` · ${draft.volumes.length} 卷 · ${draft.chapters.length} 章`}
                {requestedCount && draft.chapters.length !== requestedCount && (
                  <span className="draft-warn">
                    （你要求 {requestedCount} 章，当前 {draft.chapters.length} 章）
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="field">
            <label>一句话简介</label>
            <textarea
              rows={2}
              value={draft.logline}
              onChange={(e) => patch({ logline: e.target.value })}
              placeholder="主角是谁，想要什么，阻力是什么"
            />
          </div>

          <div className="field">
            <label>文风要求（会作为之后每次生成的基准）</label>
            <textarea
              rows={3}
              value={draft.styleGuide}
              onChange={(e) => patch({ styleGuide: e.target.value })}
              placeholder="叙述冷峻克制，白描为主，少用形容词"
            />
          </div>

          <div className="field">
            <label>叙述视角</label>
            <select
              value={draft.pov ?? 'third-limited'}
              onChange={(e) => patch({ pov: e.target.value as NovelDraft['pov'] })}
              style={{ width: '100%' }}
            >
              <option value="third-limited">第三人称限知（跟一个角色）</option>
              <option value="first">第一人称限知（我）</option>
              <option value="third-omniscient">第三人称全知</option>
              <option value="multi">多视角轮换</option>
            </select>
            <input
              className="inline-edit"
              style={{ marginTop: 6 }}
              value={draft.povNote ?? ''}
              onChange={(e) => patch({ povNote: e.target.value })}
              placeholder="允许的切换（可选）：每卷最后一章切到反派视角，另起一节并以人名开头"
            />
          </div>

          <div className="field">
            <label>
              设定条目（{draft.entities.length}）· 名称与摘要可直接改，× 删除
            </label>
            <div className="draft-entities">
              {draft.entities.map((e, i) => (
                <div className="draft-entity" key={i}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="tag">{TYPE_LABEL[e.type] ?? e.type}</span>
                    <input
                      className="inline-edit"
                      value={e.name}
                      onChange={(ev) => patchEntity(i, { name: ev.target.value })}
                      placeholder="名称"
                    />
                    {e.pinned && <span className="pin">固定</span>}
                    <button
                      className="ghost"
                      style={{ padding: '0 6px', fontSize: 12 }}
                      onClick={() => removeEntity(i)}
                      title="删除这条设定"
                    >
                      ×
                    </button>
                  </div>
                  <input
                    className="inline-edit"
                    style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}
                    value={e.summary}
                    onChange={(ev) => patchEntity(i, { summary: ev.target.value })}
                    placeholder="一句话摘要"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="field">
            <label>卷章大纲（标题与大纲可直接改；不满意的单章可重做或删掉）</label>
            <div className="draft-outline">
              {draft.volumes.map((v, vi) => (
                <div key={vi}>
                  <input
                    className="inline-edit draft-volume-input"
                    value={v.title}
                    onChange={(e) => patchVolume(vi, e.target.value)}
                    placeholder="卷名"
                  />
                  {draft.chapters
                    .map((c, gi) => ({ c, gi }))
                    .filter(({ c }) => c.volumeIndex === vi)
                    .map(({ c, gi }) => (
                      <div className="draft-chapter" key={gi}>
                        <div className="draft-chapter-row">
                          <input
                            className="inline-edit"
                            value={c.title}
                            onChange={(e) => patchChapter(gi, { title: e.target.value })}
                            placeholder="章节名"
                          />
                          <button
                            className="count-chip draft-regen"
                            disabled={regenIndex !== null}
                            onClick={() => void regenChapter(gi)}
                            title="只重做这一章的大纲"
                          >
                            {regenIndex === gi ? '重做中…' : '↻ 重做'}
                          </button>
                          <button
                            className="ghost"
                            style={{ padding: '0 6px', fontSize: 12 }}
                            onClick={() => removeChapter(gi)}
                            title="删掉这一章"
                          >
                            ×
                          </button>
                        </div>
                        <textarea
                          className="draft-chapter-outline"
                          rows={2}
                          value={c.outline}
                          onChange={(e) => patchChapter(gi, { outline: e.target.value })}
                          placeholder="本章梗概"
                        />
                      </div>
                    ))}
                </div>
              ))}
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={() => setDraft(null)} disabled={creating}>
              ← 回到对话
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
