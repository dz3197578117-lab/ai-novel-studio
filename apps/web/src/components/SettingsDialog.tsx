import { useEffect, useMemo, useState } from 'react';
import type { ModelProfilePublic, Settings } from '@novelforge/shared';
import { api } from '../api/client';
import { Modal } from './Modal';

/** 常用服务商预设，点一下填好地址与模型，省去查文档 */
const PRESETS: { name: string; baseUrl: string; model: string }[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
  { name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:14b' },
];

interface EditState {
  id: string | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

function emptyEdit(): EditState {
  return {
    id: null,
    name: '',
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.85,
    maxTokens: 4096,
  };
}

function toEdit(p: ModelProfilePublic): EditState {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKeyMasked, // 回显打码值，后端识别到掩码会保留真实 Key
    model: p.model,
    temperature: p.temperature,
    maxTokens: p.maxTokens,
  };
}

interface DshInfo {
  available: boolean;
  home: string;
  keys: { name: string; masked: string }[];
  recommended: string | null;
  hasAccountToken: boolean;
}

/**
 * 设置：多套模型配置，可随时切换当前使用哪一套。
 * 模型名支持从服务商拉取列表，也可手填。
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [image, setImage] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [dsh, setDsh] = useState<DshInfo | null>(null);
  const [dshBusy, setDshBusy] = useState(false);

  async function reload() {
    try {
      const s = await api.get<Settings>('/api/settings');
      setSettings(s);
      setImage(s.image);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  useEffect(() => {
    if (!open) return;
    setEditing(null);
    setModels([]);
    setMsg(null);
    void reload();
    void api
      .get<DshInfo>('/api/dsh/status')
      .then(setDsh)
      .catch(() => setDsh(null));
  }, [open]);

  /** 一键把 DSH 本机登录的 DeepSeek Key 复制过来 */
  async function importFromDsh() {
    setDshBusy(true);
    try {
      const r = await api.post<{ profile: ModelProfilePublic; sourceKey: string; reused: boolean }>(
        '/api/dsh/import',
        {},
      );
      await reload();
      setMsg({
        ok: true,
        text: `${r.reused ? '已存在，' : ''}已导入「${r.profile.name}」（来源 ${r.sourceKey}），并设为当前模型`,
      });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setDshBusy(false);
    }
  }

  const activeId = settings?.activeProfileId ?? null;
  const profiles = settings?.profiles ?? [];
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeId) ?? null,
    [profiles, activeId],
  );

  async function activate(id: string) {
    setBusy(true);
    try {
      await api.post(`/api/profiles/${id}/activate`);
      await reload();
      setMsg({ ok: true, text: '已切换当前模型' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: ModelProfilePublic) {
    if (!confirm(`删除配置「${p.name}」？`)) return;
    setBusy(true);
    try {
      await api.del(`/api/profiles/${p.id}`);
      if (editing?.id === p.id) setEditing(null);
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile() {
    if (!editing) return;
    if (!editing.name.trim() || !editing.baseUrl.trim() || !editing.model.trim()) {
      setMsg({ ok: false, text: '名称、Base URL、模型名都要填' });
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: editing.name.trim(),
        baseUrl: editing.baseUrl.trim(),
        model: editing.model.trim(),
        apiKey: editing.apiKey,
        temperature: editing.temperature,
        maxTokens: editing.maxTokens,
      };
      if (editing.id) await api.patch(`/api/profiles/${editing.id}`, body);
      else await api.post('/api/profiles', body);
      setMsg({ ok: true, text: '已保存' });
      setEditing(null);
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  /** 拉取该服务商的可用模型 */
  async function loadModels() {
    if (!editing) return;
    setFetchingModels(true);
    setMsg(null);
    try {
      const res = await api.post<{ models: string[]; count: number }>('/api/models', {
        baseUrl: editing.baseUrl.trim(),
        apiKey: editing.apiKey,
        profileId: editing.id ?? undefined,
      });
      setModels(res.models);
      setMsg({
        ok: true,
        text: res.count
          ? `拿到 ${res.count} 个模型，可从下拉中选择`
          : '服务商没返回模型列表，请手动填写模型名',
      });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setFetchingModels(false);
    }
  }

  async function testActive() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; sample: string; profile: string }>(
        '/api/settings/test',
      );
      setMsg({ ok: true, text: `「${r.profile}」连接成功：${r.sample}` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function saveImage() {
    setBusy(true);
    try {
      await api.put('/api/settings/image', image);
      setMsg({ ok: true, text: '图片配置已保存' });
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="设置" wide>
      {/* ── 从 DSH 一键导入 ── */}
      <div className="settings-section">
        <div className="settings-head">
          <h3>从 DeepSeek Harness 导入</h3>
        </div>
        {dsh?.available && dsh.keys.length > 0 ? (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              检测到本机 DSH 已登录，可直接复用它的 DeepSeek Key，不用再手抄一遍。
              只会读取，不会修改 DSH 的任何文件；Key 存进 NovelForge 自己的数据库。
            </p>
            <div className="hint" style={{ marginBottom: 8 }}>
              可用 Key：{dsh.keys.map((k) => `${k.name}（${k.masked}）`).join('、')}
            </div>
            <button className="primary" onClick={() => void importFromDsh()} disabled={dshBusy}>
              {dshBusy ? '导入中…' : '使用 DSH 的 DeepSeek 接入'}
            </button>
          </>
        ) : (
          <p className="hint" style={{ marginTop: 0 }}>
            没有检测到 DSH 的登录凭据（{dsh?.home ?? '~/.dsh'}）。可以在下面手动添加模型配置。
          </p>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-head">
          <h3>模型配置</h3>
          <button
            style={{ padding: '4px 12px' }}
            onClick={() => {
              setEditing(emptyEdit());
              setModels([]);
              setMsg(null);
            }}
            disabled={Boolean(editing)}
          >
            ＋ 添加
          </button>
        </div>

        <p className="hint">
          可以存多套配置（比如 DeepSeek 日常用、Ollama 离线用），随时切换当前使用哪一套。
        </p>

        {profiles.length === 0 && <div className="empty">还没有配置，点「＋ 添加」</div>}

        {profiles.map((p) => {
          const isActive = p.id === activeId;
          return (
            <div className={`profile-row${isActive ? ' active' : ''}`} key={p.id}>
              <div className="profile-main">
                <div className="profile-name">
                  {p.name}
                  {isActive && <span className="tag">当前</span>}
                  {!p.hasApiKey && <span className="profile-warn">未填 Key</span>}
                </div>
                <div className="profile-meta">
                  {p.model} · {p.baseUrl}
                </div>
              </div>
              <div className="profile-actions">
                <button
                  style={{ padding: '3px 10px', fontSize: 12 }}
                  disabled={busy || isActive}
                  onClick={() => void activate(p.id)}
                >
                  {isActive ? '使用中' : '设为当前'}
                </button>
                <button
                  style={{ padding: '3px 10px', fontSize: 12 }}
                  onClick={() => {
                    setEditing(toEdit(p));
                    setModels([]);
                    setMsg(null);
                  }}
                >
                  编辑
                </button>
                <button
                  className="danger"
                  style={{ padding: '3px 10px', fontSize: 12 }}
                  disabled={busy}
                  onClick={() => void remove(p)}
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}

        {!editing && (
          <div style={{ marginTop: 10 }}>
            <button onClick={() => void testActive()} disabled={busy || !activeProfile}>
              测试当前配置
            </button>
          </div>
        )}

        {editing && (
          <div className="profile-editor">
            <div className="count-presets" style={{ marginBottom: 10 }}>
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  className="count-chip"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      name: editing.name || preset.name,
                      baseUrl: preset.baseUrl,
                      model: preset.model,
                    })
                  }
                >
                  {preset.name}
                </button>
              ))}
            </div>

            <div className="row">
              <div className="field">
                <label>配置名称</label>
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="如：DeepSeek 官方"
                  autoFocus
                />
              </div>
              <div className="field" style={{ flex: 2 }}>
                <label>Base URL</label>
                <input
                  value={editing.baseUrl}
                  onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                  placeholder="https://api.deepseek.com/v1"
                />
              </div>
            </div>

            <div className="field">
              <label>
                API Key
                {editing.id && editing.apiKey.includes('••••') && (
                  <span className="pin">（已保存，不改就留着）</span>
                )}
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="password"
                  value={editing.apiKey}
                  onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                  placeholder="sk-…"
                  style={{ flex: 1 }}
                />
                <button
                  style={{ flex: 'none' }}
                  onClick={() => void loadModels()}
                  disabled={fetchingModels || !editing.baseUrl.trim()}
                  title="获取该服务商支持的模型列表"
                >
                  {fetchingModels ? '拉取中…' : '拉取模型'}
                </button>
              </div>
            </div>

            <div className="field">
              <label>模型名</label>
              {models.length > 0 ? (
                <select
                  value={editing.model}
                  onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                >
                  {editing.model && !models.includes(editing.model) && (
                    <option value={editing.model}>{editing.model}（手填）</option>
                  )}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={editing.model}
                  onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                  placeholder="deepseek-chat（也可点「拉取模型」选择）"
                />
              )}
            </div>

            <div className="row">
              <div className="field">
                <label>Temperature {editing.temperature}</label>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={editing.temperature}
                  onChange={(e) =>
                    setEditing({ ...editing, temperature: Number(e.target.value) })
                  }
                />
              </div>
              <div className="field">
                <label>最大输出 tokens</label>
                <input
                  type="number"
                  value={editing.maxTokens}
                  onChange={(e) =>
                    setEditing({ ...editing, maxTokens: Number(e.target.value) || 4096 })
                  }
                />
              </div>
            </div>

            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setEditing(null)} disabled={busy}>
                取消
              </button>
              <button className="primary" onClick={() => void saveProfile()} disabled={busy}>
                {busy ? '保存中…' : '保存配置'}
              </button>
            </div>
          </div>
        )}
      </div>

      {msg && (
        <div
          style={{
            fontSize: 12,
            padding: '8px 10px',
            borderRadius: 6,
            background: msg.ok ? 'rgba(79,157,105,.14)' : 'rgba(217,83,79,.14)',
            color: msg.ok ? 'var(--ok)' : 'var(--danger)',
            margin: '4px 0 12px',
            lineHeight: 1.6,
          }}
        >
          {msg.text}
        </div>
      )}

      <div className="settings-section">
        <div className="settings-head">
          <h3>图片模型（可选，用于封面插图）</h3>
        </div>
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
          <label>API Key</label>
          <input
            type="password"
            value={image.apiKey}
            onChange={(e) => setImage({ ...image, apiKey: e.target.value })}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => void saveImage()} disabled={busy}>
            保存图片配置
          </button>
        </div>
      </div>

      <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7, marginTop: 6 }}>
        所有 Key 只保存在本机数据库（apps/server/data），不会上传到任何第三方。
      </p>
    </Modal>
  );
}
