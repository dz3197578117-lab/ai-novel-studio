/** 极简 API 客户端。所有网络请求都从这里走，便于统一处理错误。 */

const TOKEN_KEY = 'novelforge:token';

/** 局域网访问时服务端会要求访问令牌（ACCESS_TOKEN） */
export function authHeaders(): Record<string, string> {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

/** 401 时问一次口令，存下来后重试 */
function askToken(): string | null {
  try {
    const t = window.prompt('该工作台启用了访问令牌，请输入启动时设置的 ACCESS_TOKEN：');
    if (!t?.trim()) return null;
    localStorage.setItem(TOKEN_KEY, t.trim());
    return t.trim();
  } catch {
    return null;
  }
}

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...init?.headers,
    },
  });

  if (res.status === 401 && !retried && askToken()) {
    return request<T>(path, init, true);
  }

  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      /* 非 JSON 错误 */
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  /** 下载文件（导出用），触发浏览器保存 */
  async download(path: string, body: unknown, fallbackName: string): Promise<void> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    };
    let res = await fetch(path, init);
    if (res.status === 401 && askToken()) {
      res = await fetch(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
    }
    if (!res.ok) {
      let message = `导出失败 (${res.status})`;
      try {
        const j = (await res.json()) as { message?: string };
        message = j.message ?? message;
      } catch {
        /* ignore */
      }
      throw new ApiError(message, res.status);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') ?? '';
    const match = /filename="?([^";]+)"?/.exec(cd);
    const name = match ? decodeURIComponent(match[1]!) : fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  },
};
