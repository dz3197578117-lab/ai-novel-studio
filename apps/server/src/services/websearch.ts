/**
 * 联网查资料（无需 API Key）。
 *
 * 为什么用它：本地知识库只覆盖作者上传的资料；像「内务府某司掌什么」这类史实
 * 知识库往往没有，模型就会凭印象写。联网检索能把真实来源带进来，并在线索里
 * 标明出处（URL），避免「模型自己编的」和「查到的」混在一起。
 *
 * 引擎选择：本机网络环境访问维基/DuckDuckGo 会超时，所以主力用
 * 360 搜索（so.com，返回绝对链接，最好解析）与搜狗；两家都失败时再兜底国际引擎。
 */

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  /** 来源引擎，便于前端标注 */
  engine: 'so360' | 'sogou' | 'duckduckgo' | 'wikipedia';
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TIMEOUT_MS = 8000;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function headers(): Record<string, string> {
  return {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Accept: 'text/html,application/xhtml+xml',
  };
}

/** 解析 360 搜索结果（<li class="res-list">） */
export function parseSo360(html: string, limit = 5): WebResult[] {
  const out: WebResult[] = [];
  const blockRe = /<li[^>]+class="[^"]*res-list[^"]*"[\s\S]*?(?=<li[^>]+class="[^"]*res-list|<\/ul>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && out.length < limit) {
    const block = m[0];
    const link = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/.exec(block);
    if (!link) continue;
    const title = /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const summary =
      /<span[^>]+class="[^"]*res-list-summary[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(block) ??
      /<p[^>]+class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const url = decodeEntities(link[1]!);
    if (!/^https?:\/\//.test(url)) continue;
    out.push({
      title: title ? decodeEntities(title[1]!) : url,
      url,
      snippet: summary ? decodeEntities(summary[1]!).slice(0, 300) : '',
      engine: 'so360',
    });
  }
  return out;
}

/** 解析搜狗搜索结果（<div class="vrwrap">，链接是 /link?url= 相对地址） */
export function parseSogou(html: string, limit = 5): WebResult[] {
  const out: WebResult[] = [];
  const blockRe = /<div[^>]+class="[^"]*vrwrap[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*vrwrap|<\/body>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && out.length < limit) {
    const block = m[0];
    const link = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/.exec(block);
    if (!link) continue;
    const title = /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const summary =
      /<div[^>]+id="cacheresult_summary[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block) ??
      /<div[^>]+class="[^"]*(?:fz-mid|space-txt|text-layout)[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);

    let url = decodeEntities(link[1]!);
    if (url.startsWith('/')) url = `https://www.sogou.com${url}`;
    if (!/^https?:\/\//.test(url)) continue;

    out.push({
      title: title ? decodeEntities(title[1]!) : url,
      url,
      snippet: summary ? decodeEntities(summary[1]!).slice(0, 300) : '',
      engine: 'sogou',
    });
  }
  return out;
}

async function fetchText(url: string, timeout = TIMEOUT_MS): Promise<string> {
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(timeout) });
  if (!res.ok) return '';
  return res.text();
}

async function fromSo360(query: string, limit: number): Promise<WebResult[]> {
  const html = await fetchText(`https://www.so.com/s?q=${encodeURIComponent(query)}`);
  return parseSo360(html, limit);
}

async function fromSogou(query: string, limit: number): Promise<WebResult[]> {
  const html = await fetchText(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`);
  return parseSogou(html, limit);
}

async function fromDuckDuckGo(query: string, limit: number): Promise<WebResult[]> {
  const html = await fetchText(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    4000,
  );
  const out: WebResult[] = [];
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && out.length < limit) {
    let url = decodeEntities(m[1]!);
    const u = /[?&]uddg=([^&]+)/.exec(url);
    if (u) url = decodeURIComponent(u[1]!);
    if (!/^https?:\/\//.test(url)) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/.exec(m[3]!);
    out.push({
      title: decodeEntities(m[2]!),
      url,
      snippet: snippet ? decodeEntities(snippet[1]!).slice(0, 300) : '',
      engine: 'duckduckgo',
    });
  }
  return out;
}

export async function searchWeb(query: string, limit = 5): Promise<WebResult[]> {
  const q = query.trim();
  if (!q) return [];

  const collected: WebResult[] = [];
  const seen = new Set<string>();
  const push = (list: WebResult[]) => {
    for (const r of list) {
      const key = r.url.replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(r);
      if (collected.length >= limit) break;
    }
  };

  for (const engine of [fromSo360, fromSogou]) {
    if (collected.length >= limit) break;
    try {
      push(await engine(q, limit));
    } catch {
      /* 单引擎失败继续下一个 */
    }
  }
  if (collected.length === 0) {
    try {
      push(await fromDuckDuckGo(q, limit));
    } catch {
      /* 网络受限时静默降级 */
    }
  }
  return collected.slice(0, limit);
}
