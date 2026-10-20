import { useEffect, useState } from 'react';
import type { CurrentVersion, UpdateInfo } from '@novelforge/shared';
import { api } from '../api/client';

const UPGRADE_CMD = 'git pull origin main && pnpm install';

/**
 * 版本与更新。
 *
 * 只做「检测 + 告诉你怎么升」，不自动替换正在运行的程序文件——
 * 本地服务跑在 Node 里，替换源码需要重启，中途失败会让应用起不来，
 * 这个风险留给用户在自己方便的时候做。
 */
export function UpdatePanel() {
  const [current, setCurrent] = useState<CurrentVersion | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 打开设置时只读本地版本，不联网
  useEffect(() => {
    api
      .get<CurrentVersion>('/api/update/current')
      .then(setCurrent)
      .catch(() => undefined);
  }, []);

  async function check(force = false) {
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      const r = await api.get<UpdateInfo>(`/api/update/check${force ? '?force=1' : ''}`);
      setInfo(r);
      setCurrent(r.current);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(UPGRADE_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr('浏览器不允许写剪贴板，请手动复制下面的命令');
    }
  }

  const status = info?.status;
  const showCommand = status === 'behind' || status === 'diverged';
  const tone =
    status === 'behind' || status === 'diverged' ? 'warn' : status === 'up-to-date' ? 'ok' : 'plain';

  return (
    <div className="settings-section">
      <div className="settings-head">
        <h3>版本与更新</h3>
      </div>

      <p className="hint" style={{ marginTop: 0 }}>
        当前 v{current?.version ?? '…'}
        {current?.commit ? ` · 提交 ${current.commit}` : ''}
        {current?.branch ? ` · 分支 ${current.branch}` : ''}
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => void check()} disabled={busy}>
          {busy ? '检查中…' : '检查更新'}
        </button>
        {info && (
          <button onClick={() => void check(true)} disabled={busy} title="忽略 10 分钟缓存">
            重新检查
          </button>
        )}
        <span className="hint" style={{ margin: 0 }}>
          只读访问 GitHub 公共接口，不上传任何作品内容或 Key
        </span>
      </div>

      {err && (
        <p style={{ fontSize: 12, color: 'var(--danger)', margin: '10px 0 0' }}>{err}</p>
      )}

      {info && !err && (
        <div
          style={{
            marginTop: 10,
            padding: '10px 12px',
            borderRadius: 6,
            lineHeight: 1.7,
            fontSize: 12,
            background:
              tone === 'warn'
                ? 'var(--accent-soft)'
                : tone === 'ok'
                  ? 'rgba(79,157,105,.12)'
                  : 'rgba(255,255,255,.04)',
            color:
              tone === 'warn' ? 'var(--accent)' : tone === 'ok' ? 'var(--ok)' : 'var(--text)',
          }}
        >
          {status === 'up-to-date' && <div>✓ 已是最新版本（{info.current.commit}）</div>}

          {status === 'behind' && (
            <>
              <div style={{ fontWeight: 600 }}>
                ↑ 有新版本
                {info.behindBy ? `：落后 ${info.behindBy} 个提交` : ''}
              </div>
              {info.latest && (
                <div style={{ marginTop: 4 }}>
                  最新提交 <code>{info.latest.short}</code>
                  {info.latest.date ? `（${info.latest.date.slice(0, 10)}）` : ''}：
                  {info.latest.message}
                </div>
              )}
            </>
          )}

          {status === 'diverged' && (
            <div style={{ fontWeight: 600 }}>
              本机与远程各有独立提交（领先 {info.aheadBy ?? '?'} / 落后 {info.behindBy ?? '?'}），
              直接 pull 可能产生冲突，建议先确认本地改动。
            </div>
          )}

          {status === 'ahead' && (
            <div>本机比远程多 {info.aheadBy ?? 0} 个提交，属于开发中的状态，无需升级。</div>
          )}

          {status === 'no-git' && (
            <div>
              当前是压缩包安装，没有 git 历史，无法比对版本。
              请下载最新压缩包，覆盖程序文件（<b>保留 apps/server/data 目录</b>）。
            </div>
          )}

          {status === 'offline' && (
            <div style={{ color: 'var(--muted)' }}>
              暂时查不到远程版本：{info.message ?? '网络不可用'}。
              这不影响本地写作，稍后再试即可。
            </div>
          )}

          {status === 'error' && (
            <div style={{ color: 'var(--danger)' }}>{info.message ?? '检查失败'}</div>
          )}

          {showCommand && info.current.canPull && (
            <div style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 4 }}>在项目目录执行，然后重启服务：</div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  background: 'rgba(0,0,0,.18)',
                  borderRadius: 4,
                  padding: '6px 8px',
                }}
              >
                <code style={{ flex: 1, fontSize: 12 }}>{UPGRADE_CMD}</code>
                <button onClick={() => void copyCmd()} style={{ padding: '2px 8px', fontSize: 11 }}>
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <div style={{ marginTop: 6, opacity: 0.8 }}>
                升级前先关掉服务并备份 <code>apps/server/data</code>；数据库结构不会变，作品数据原地保留。
              </div>
            </div>
          )}

          {showCommand && !info.current.canPull && (
            <div style={{ marginTop: 6, opacity: 0.85 }}>
              当前安装方式不支持 git pull，请按上面的方式重新下载覆盖。
            </div>
          )}
        </div>
      )}
    </div>
  );
}
