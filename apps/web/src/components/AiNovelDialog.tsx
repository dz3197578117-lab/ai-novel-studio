import { useEffect, useRef, useState } from 'react';
import type { InterviewReply, NovelDraft, Project } from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { Modal } from './Modal';

const CHAPTER_OPTIONS = [6, 10, 15, 20, 30];
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

  const chatRef = useRef<HTMLDivElement | null>(null);
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

  async function create() {
    if (!draft) return;
    setCreating(true);
    try {
      const res = await api.post<{ project: Project }>('/api/projects/from-draft', { draft });
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
