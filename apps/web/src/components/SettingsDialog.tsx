import { useEffect, useState } from 'react';
import type { Settings } from '@novelforge/shared';
import { api } from '../api/client';
import { Modal } from './Modal';

/** 设置：模型接入 + 连通性测试 + 导出 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState({ baseUrl: '', apiKey: '', model: '', temperature: 0.85, maxTokens: 4096 });
  const [image, setImage] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [hasTextKey, setHasTextKey] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const s = await api.get<Settings>('/api/settings');
        setText(s.text);
        setImage(s.image);
        setHasTextKey(s.hasTextKey);
        setMsg(null);
      } catch (e) {
        setMsg({ ok: false, text: (e as Error).message });
      }
    })();
  }, [open]);

  async function save(next?: Partial<typeof text>) {
    setBusy(true);
    try {
      const t = { ...text, ...next };
      await api.put('/api/settings', { text: t, image });
      setText(t);
      setHasTextKey(Boolean(t.apiKey && !t.apiKey.includes('••••')) || hasTextKey);
      setMsg({ ok: true, text: '已保存' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; sample: string }>('/api/settings/test');
      setMsg({ ok: true, text: `连接成功，模型回复：${r.sample}` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="设置">
      <h3 style={{ fontSize: 13, margin: '4px 0 10px', color: 'var(--accent)' }}>文本模型（OpenAI 兼容）</h3>
      <div className="field">
        <label>Base URL</label>
        <input
          value={text.baseUrl}
          onChange={(e) => setText({ ...text, baseUrl: e.target.value })}
          placeholder="https://api.deepseek.com/v1"
        />
      </div>
      <div className="row">
        <div className="field">
          <label>模型名</label>
          <input
            value={text.model}
            onChange={(e) => setText({ ...text, model: e.target.value })}
            placeholder="deepseek-chat"
          />
        </div>
        <div className="field">
          <label>API Key {hasTextKey && <span className="pin">（已保存）</span>}</label>
          <input
            type="password"
            value={text.apiKey}
            onChange={(e) => setText({ ...text, apiKey: e.target.value })}
            placeholder="sk-…"
          />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>Temperature {text.temperature}</label>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={text.temperature}
            onChange={(e) => setText({ ...text, temperature: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>最大输出 tokens</label>
          <input
            type="number"
            value={text.maxTokens}
            onChange={(e) => setText({ ...text, maxTokens: Number(e.target.value) })}
          />
        </div>
      </div>

      <h3 style={{ fontSize: 13, margin: '16px 0 10px', color: 'var(--accent)' }}>图像模型（可选，用于封面插图）</h3>
      <div className="row">
        <div className="field">
          <label>Base URL</label>
          <input
            value={image.baseUrl}
            onChange={(e) => setImage({ ...image, baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>
        <div className="field">
          <label>模型名</label>
          <input
            value={image.model}
            onChange={(e) => setImage({ ...image, model: e.target.value })}
            placeholder="gpt-image-1"
          />
        </div>
      </div>
      <div className="field">
        <label>图像 API Key</label>
        <input
          type="password"
          value={image.apiKey}
          onChange={(e) => setImage({ ...image, apiKey: e.target.value })}
        />
      </div>

      {msg && (
        <div
          style={{
            fontSize: 12,
            padding: '8px 10px',
            borderRadius: 6,
            background: msg.ok ? 'rgba(79,157,105,.14)' : 'rgba(217,83,79,.14)',
            color: msg.ok ? 'var(--ok)' : 'var(--danger)',
            marginBottom: 12,
            lineHeight: 1.6,
          }}
        >
          {msg.text}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={test} disabled={busy}>
          测试连接
        </button>
        <button className="primary" onClick={() => save()} disabled={busy}>
          保存
        </button>
      </div>

      <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7, marginTop: 16 }}>
        API Key 只保存在本机数据库（apps/server/data），不会上传到任何第三方。 换模型只需改这里的
        Base URL 与模型名，无需改代码。
      </p>
    </Modal>
  );
}
