import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { CurrentVersion, UpdateInfo } from '@novelforge/shared';
import { SERVER_ROOT } from '../config.js';

const run = promisify(execFile);

/** 仓库根目录：apps/server/../.. */
const REPO_ROOT = path.resolve(SERVER_ROOT, '../..');

/** 解析不到 origin 时的兜底 */
const FALLBACK_REPO = 'dz3197578117-lab/ai-novel-studio';

/** 结果缓存，避免反复点按钮把 GitHub 限额耗光（未认证 60 次/小时） */
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; data: UpdateInfo } | null = null;

async function git(args: string[], cwd: string, timeout = 3000): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      timeout,
      // 没有凭据时 git 会停下来等输入，非交互环境直接卡死；这里明确禁止提示
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** 从 origin 地址里抠出 owner/repo，支持 https 与 ssh 两种写法 */
function parseRepo(url: string | null): string | null {
  if (!url) return null;
  const m =
    /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i.exec(url.trim()) ??
    /^([^/]+)\/([^/]+)$/.exec(url.trim());
  if (!m?.[1] || !m[2]) return null;
  return `${m[1]}/${m[2]}`;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface RemoteCommit {
  sha: string;
  commit: { message: string; committer: { date: string } };
  html_url: string;
}

/** GitHub 公开 API：只读，不发送任何本地数据 */
async function github<T>(pathname: string): Promise<{ data: T | null; error?: string }> {
  const token = process.env.GITHUB_TOKEN;
  try {
    const res = await fetch(`https://api.github.com${pathname}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'NovelForge-UpdateCheck',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return { data: null, error: '仓库不存在或已设为私有' };
    if (res.status === 403) return { data: null, error: 'GitHub 接口限流，请稍后再试' };
    if (!res.ok) return { data: null, error: `GitHub 返回 ${res.status}` };
    return { data: (await res.json()) as T };
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? '请求超时' : '无法连接 GitHub';
    return { data: null, error: msg };
  }
}

async function collect(force: boolean): Promise<UpdateInfo> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const headSha = await git(['rev-parse', 'HEAD'], REPO_ROOT);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT);
  const date = await git(['log', '-1', '--format=%cI'], REPO_ROOT);
  const current: CurrentVersion = {
    version: readVersion(),
    commit: headSha ? headSha.slice(0, 7) : null,
    date,
    branch,
    canPull: Boolean(headSha),
  };
  const repo = parseRepo(await git(['remote', 'get-url', 'origin'], REPO_ROOT)) ?? FALLBACK_REPO;

  const base: UpdateInfo = {
    current,
    latest: null,
    status: 'no-git',
    behindBy: null,
    aheadBy: null,
    repo,
    checkedAt: new Date().toISOString(),
  };

  // 没有 git 历史（压缩包安装）：无法比对，只能提示重新下载
  if (!current.commit) {
    base.message = '当前版本是从压缩包解压安装的，无法与仓库比对提交。';
    cache = { at: Date.now(), data: base };
    return base;
  }

  /**
   * 拿远程 HEAD。两条路：
   * 1) GitHub API —— 顺带拿到提交说明，常态走这条
   * 2) `git ls-remote` —— 不消耗 API 配额，用于 API 限流时的兜底
   */
  let remoteSha: string | null = null;
  let remoteCommitInfo: RemoteCommit | null = null;
  let remoteError: string | undefined;

  const api = await github<RemoteCommit>(`/repos/${repo}/commits/main`);
  if (api.data) {
    remoteSha = api.data.sha;
    remoteCommitInfo = api.data;
  } else {
    remoteError = api.error;
    const ls = await git(['ls-remote', 'origin', 'refs/heads/main'], REPO_ROOT, 6000);
    const sha = ls?.split(/\s+/)[0];
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) remoteSha = sha;
  }

  if (!remoteSha) {
    base.status = 'offline';
    base.message = remoteError ?? '无法获取远程版本';
    cache = { at: Date.now(), data: base };
    return base;
  }

  if (remoteSha === headSha) {
    base.status = 'up-to-date';
    cache = { at: Date.now(), data: base };
    return base;
  }

  /**
   * 版本不同，判断领先/落后。
   * 优先用本地已有的 git 对象算（`rev-list --count`），完全不依赖网络与 API 配额；
   * 本地没有该对象时才问 GitHub compare。
   */
  const hasObject = await git(['rev-parse', '--verify', `${remoteSha}^{commit}`], REPO_ROOT);
  if (hasObject) {
    const behind = Number(
      (await git(['rev-list', '--count', `${headSha}..${remoteSha}`], REPO_ROOT)) ?? '0',
    );
    const ahead = Number(
      (await git(['rev-list', '--count', `${remoteSha}..${headSha}`], REPO_ROOT)) ?? '0',
    );
    base.behindBy = behind;
    base.aheadBy = ahead;
    base.status = behind > 0 && ahead === 0 ? 'behind' : ahead > 0 && behind === 0 ? 'ahead' : 'diverged';
  } else {
    // 本地没有远程对象：试 API compare，再不行就只报「不一致」，不编造数字
    const cmp = await github<{ status: string; ahead_by: number; behind_by: number }>(
      `/repos/${repo}/compare/${headSha}...${remoteSha}`,
    );
    if (cmp.data) {
      base.aheadBy = cmp.data.ahead_by;
      base.behindBy = cmp.data.behind_by;
      base.status =
        cmp.data.behind_by > 0 && cmp.data.ahead_by === 0
          ? 'behind'
          : cmp.data.ahead_by > 0 && cmp.data.behind_by === 0
            ? 'ahead'
            : 'diverged';
    } else {
      base.status = 'behind';
      base.message = '远程版本与本机不同（无法比对具体差异，可能本机有未推送的提交）';
    }
  }

  // 有提交说明就展示；API 不可用时不影响「是否落后」的结论
  if (remoteCommitInfo) {
    base.latest = {
      commit: remoteCommitInfo.sha,
      short: remoteCommitInfo.sha.slice(0, 7),
      date: remoteCommitInfo.commit.committer.date,
      message: remoteCommitInfo.commit.message.split('\n')[0] ?? '',
      url: remoteCommitInfo.html_url,
    };
  }

  cache = { at: Date.now(), data: base };
  return base;
}

/** 只读本地信息，不联网 */
export async function readCurrent(): Promise<CurrentVersion> {
  const commit = await git(['rev-parse', 'HEAD'], REPO_ROOT);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT);
  const date = await git(['log', '-1', '--format=%cI'], REPO_ROOT);
  return {
    version: readVersion(),
    commit: commit ? commit.slice(0, 7) : null,
    date,
    branch,
    canPull: Boolean(commit),
  };
}

export async function updateRoutes(app: FastifyInstance): Promise<void> {
  /** 当前版本（纯本地读，不产生网络请求） */
  app.get('/api/update/current', async () => readCurrent());

  /**
   * 检查更新。
   * 只读取本地 git 信息 + 请求 GitHub 公开接口，不上传任何作品内容或 Key。
   */
  app.get<{ Querystring: { force?: string } }>('/api/update/check', async (req) => {
    const force = req.query.force === '1';
    if (force) cache = null;
    return collect(force);
  });
}
