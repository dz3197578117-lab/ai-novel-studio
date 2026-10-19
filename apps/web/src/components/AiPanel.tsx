import { useRef, useState } from 'react';
import type { MemoryUsage, WriteMode } from '@novelforge/shared';
import { useNovel } from '../store/novel';
import { api } from '../api/client';
import { streamWrite } from '../api/stream';

const MODES: { key: WriteMode; label: string; hint: string }[] = [
  { key: 'continue', label: '续写', hint: '顺着正文往下写' },
  { key: 'rewrite', label: '改写', hint: '改写选中片段' },
  { key: 'polish', label: '润色', hint: '改善表达' },
  { key: 'expand', label: '扩写', hint: '补充细节' },
  { key: 'style', label: '仿写', hint: '模仿指定文风' },
];

/** 右侧：AI 写作面板 */
export function AiPanel() {
  const chapter = useNovel((s) => s.currentChapter);
  const project = useNovel((s) => s.project);
  const setError = useNovel((s) => s.setError);

  const [mode, setMode] = useState<WriteMode>('continue');
  const [instruction, setInstruction] = useState('');
  const [result, setResult] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [memory, setMemory] = useState<MemoryUsage[]>([]);
  const [summary, setSummary] = useState('');
  const abortRef = useRef<(() => void) | null>(null);

  function generate() {
    if (!project || !chapter) return;
    setResult('');
    setMemory([]);
    setStreaming(true);

    abortRef.current = streamWrite(
      {
        projectId: project.id,
        chapterId: chapter.id,
        mode,
        instruction: instruction.trim() || undefined,
        selection: mode === 'continue' ? undefined : getSelectionText() || undefined,
        memoryBudget: 6000,
      },
      {
        onMeta: (m) => setMemory(m),
        onDelta: (t) => setResult((prev) => prev + t),
        onDone: () => setStreaming(false),
        onError: (msg) => {
          setError(msg);
          setStreaming(false);
        },
      },
    );
  }

  function stop() {
    abortRef.current?.();
    setStreaming(false);
  }

  function applyToText() {
    if (!result.trim()) return;
    window.dispatchEvent(new CustomEvent('novelforge:apply', { detail: result }));
    setResult('');
  }

  async function makeSummary() {
    if (!chapter) return;
    try {
      const r = await api.post<{ summary: string }>(`/api/chapters/${chapter.id}/summarize`);
      setSummary(r.summary);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!chapter) {
    return (
      <aside className="rightbar">
        <div className="empty">选择一个章节后，这里会出现 AI 工具</div>
      </aside>
    );
  }

  return (
    <aside className="rightbar">
      <div className="ai-tabs">
        {MODES.map((m) => (
          <button
            key={m.key}
            className={mode === m.key ? 'active' : ''}
            onClick={() => setMode(m.key)}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <textarea
          rows={3}
          value={instruction}
          placeholder={
            mode === 'continue'
              ? '额外要求（可留空）：比如「让对峙更紧张」「这一节写回忆」'
              : '说明你希望怎么改'
          }
          onChange={(e) => setInstruction(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="primary"
            style={{ flex: 1 }}
            onClick={generate}
            disabled={streaming}
          >
            {streaming ? '生成中…' : '生成'}
          </button>
          {streaming && <button onClick={stop}>停止</button>}
        </div>
      </div>

      <div className="result-box">
        {result || (streaming ? '…' : <div className="empty">生成的文本会出现在这里</div>)}
      </div>

      <div style={{ padding: 10, borderTop: '1px solid var(--border)', display: 'flex', gap: 6 }}>
        <button style={{ flex: 1 }} onClick={applyToText} disabled={!result.trim()}>
          添加到正文
        </button>
        <button onClick={makeSummary} title="生成该章摘要，供后续章节记忆使用">
          记忆摘要
        </button>
      </div>

      {summary && (
        <div className="result-box" style={{ maxHeight: 120, fontSize: 12, borderTop: '1px solid var(--border)' }}>
          {summary}
        </div>
      )}

      {memory.length > 0 && (
        <div className="memory-badge">
          上下文：{memory.map((m) => `${m.label}(${m.chars})`).join(' · ')}
        </div>
      )}
    </aside>
  );
}

/** 拿浏览器选区文本 */
function getSelectionText(): string {
  const sel = window.getSelection();
  if (sel && sel.toString().trim()) return sel.toString();
  const active = document.activeElement as HTMLTextAreaElement | null;
  if (active?.selectionStart !== undefined && active.selectionEnd !== undefined) {
    return active.value.slice(active.selectionStart, active.selectionEnd);
  }
  return '';
}
