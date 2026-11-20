/**
 * Zero-key open-web fallback for Kortix router proxy services (`tavily`,
 * `firecrawl`, `serper`) when paid third-party provider API keys are not set on
 * the deployment.
 *
 * Uses public RSS search feeds (Google News RSS + Bing Search RSS + Wikipedia
 * OpenSearch) for live web/news search (Arabic + English aware) and SSRF-safe
 * direct HTTP fetch + HTML-to-Markdown conversion for webpage reading.
 */

import { logger as appLogger } from '../../../lib/logger';
import { assertSafeEgressUrl, UnsafeEgressError } from '../../../shared/ssrf-guard';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_MARKDOWN_CHARS = 40_000;
const MAX_REDIRECTS = 4;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface OpenWebSearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date: string;
  source?: string;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    });
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractXmlTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(block);
  return match ? match[1]!.trim() : '';
}

function parseRssItems(xml: string, limit: number): OpenWebSearchResult[] {
  const items: OpenWebSearchResult[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null && items.length < limit) {
    const block = match[1]!;
    const title = stripTags(extractXmlTag(block, 'title'));
    const rawLink = decodeHtmlEntities(extractXmlTag(block, 'link')).trim();
    const description = stripTags(extractXmlTag(block, 'description'));
    const pubDate = stripTags(extractXmlTag(block, 'pubDate'));
    const source = stripTags(extractXmlTag(block, 'source'));
    if (!title || !rawLink) continue;
    items.push({
      title,
      url: rawLink,
      content: description || title,
      score: Math.max(0.5, Number((1 - items.length * 0.04).toFixed(2))),
      published_date: pubDate,
      ...(source ? { source } : {}),
    });
  }
  return items;
}

async function fetchGoogleNewsRss(query: string, limit: number, arabic: boolean): Promise<OpenWebSearchResult[]> {
  const params = arabic
    ? 'hl=ar&gl=EG&ceid=EG:ar'
    : 'hl=en-US&gl=US&ceid=US:en';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${params}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml, limit);
  } catch {
    return [];
  }
}

async function fetchBingWebRss(query: string, limit: number, arabic: boolean): Promise<OpenWebSearchResult[]> {
  const langParam = arabic ? '&setlang=ar&mkt=ar-SA' : '&setlang=en-US';
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${Math.min(20, Math.max(5, limit))}${langParam}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml, limit);
  } catch {
    return [];
  }
}

async function fetchWikipediaOpenSearch(query: string, limit: number, arabic: boolean): Promise<OpenWebSearchResult[]> {
  const lang = arabic ? 'ar' : 'en';
  const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${Math.min(10, limit)}&format=json`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'KortixOpenWebFallback/1.0' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as [string, string[], string[], string[]];
    const titles = Array.isArray(data[1]) ? data[1] : [];
    const snippets = Array.isArray(data[2]) ? data[2] : [];
    const urls = Array.isArray(data[3]) ? data[3] : [];
    const out: OpenWebSearchResult[] = [];
    for (let i = 0; i < titles.length && out.length < limit; i++) {
      if (!titles[i] || !urls[i]) continue;
      out.push({
        title: titles[i]!,
        url: urls[i]!,
        content: snippets[i] || titles[i]!,
        score: Number((0.75 - i * 0.05).toFixed(2)),
        published_date: '',
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function searchOpenWeb(
  query: string,
  opts: { maxResults?: number; topic?: string } = {},
): Promise<{ results: OpenWebSearchResult[]; answer: string; elapsedSeconds: number }> {
  const startedAt = Date.now();
  const limit = Math.max(1, Math.min(20, opts.maxResults ?? 5));
  const hasArabic = /[\u0600-\u06FF]/.test(query);
  const isNews =
    opts.topic === 'news' ||
    /\b(news|latest|today|recent|headlines|breaking)\b/i.test(query) ||
    /(أخبار|اخبار|الأخيرة|الاخيرة|اليوم|آخر|اخر|جديد|عاجل)/.test(query);

  const [newsItems, webItems] = await Promise.all([
    fetchGoogleNewsRss(query, limit, hasArabic),
    fetchBingWebRss(query, limit, hasArabic),
  ]);

  const ordered = isNews ? [...newsItems, ...webItems] : [...webItems, ...newsItems];
  const seen = new Set<string>();
  const deduped: OpenWebSearchResult[] = [];
  for (const item of ordered) {
    const key = `${item.title.toLowerCase()}|${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }

  if (deduped.length === 0) {
    const wikiItems = await fetchWikipediaOpenSearch(query, limit, hasArabic);
    deduped.push(...wikiItems);
  }

  const answer = deduped
    .slice(0, 3)
    .map((r) => `${r.title}${r.published_date ? ` (${r.published_date})` : ''}: ${r.content.slice(0, 220)}`)
    .join('\n');

  return {
    results: deduped,
    answer,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
  };
}

function htmlToMarkdown(html: string): { title: string; description: string; markdown: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? stripTags(titleMatch[1]!) : '';
  const descMatch =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html) ||
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(html);
  const description = descMatch ? decodeHtmlEntities(descMatch[1]!).trim() : '';

  let body = html;
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (bodyMatch) body = bodyMatch[1]!;

  // Remove non-content elements.
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|canvas|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n# ${stripTags(t)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n## ${stripTags(t)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n### ${stripTags(t)}\n`)
    .replace(/<h[4-6][^]*?>([\s\S]*?)<\/h[4-6]>/gi, (_m, t) => `\n#### ${stripTags(t)}\n`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const label = stripTags(text);
      if (!label) return '';
      if (/^(javascript:|mailto:|#)/i.test(href.trim())) return label;
      return `[${label}](${decodeHtmlEntities(href.trim())})`;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${stripTags(t)}`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|tr|blockquote|pre)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');

  const cleaned = decodeHtmlEntities(body)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_MARKDOWN_CHARS);

  return { title, description, markdown: cleaned };
}

async function fetchPublicPageSafely(rawUrl: string): Promise<{
  status: number;
  finalUrl: string;
  contentType: string;
  text: string;
}> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeEgressUrl(currentUrl, { allowHttp: true });
    const res = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return { status: res.status, finalUrl: currentUrl, contentType: 'text/plain', text: '' };
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    const contentType = res.headers.get('content-type') || 'text/html';
    const buf = await res.arrayBuffer();
    const sliced = buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(sliced);
    return { status: res.status, finalUrl: currentUrl, contentType, text };
  }
  throw new Error('Too many redirects while fetching target URL');
}

function parseJsonBody(body: ArrayBuffer | string | undefined): Record<string, any> {
  if (!body) return {};
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    return text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/**
 * Handles Tavily, Firecrawl, and Serper proxy requests without third-party keys.
 * Returns null if the service/route has no open-web fallback.
 */
export async function handleOpenWebFallback(
  serviceName: string,
  method: string,
  subPath: string,
  rawBody: ArrayBuffer | string | undefined,
): Promise<Response | null> {
  const upperMethod = method.toUpperCase();
  const normalizedPath = subPath.split('?')[0] || '/';
  if (upperMethod !== 'POST') return null;

  const json = parseJsonBody(rawBody);

  // ── Tavily POST /search ────────────────────────────────────────────────────
  if (serviceName === 'tavily' && normalizedPath === '/search') {
    const query = String(json.query ?? '').trim();
    if (!query) {
      return Response.json({ error: 'Missing query' }, { status: 400 });
    }
    const maxResults = Number(json.max_results ?? 5);
    const topic = typeof json.topic === 'string' ? json.topic : 'general';
    const { results, answer, elapsedSeconds } = await searchOpenWeb(query, { maxResults, topic });
    appLogger.info(`[PROXY] tavily open-web fallback served ${results.length} results in ${elapsedSeconds}s`);
    return Response.json(
      {
        query,
        answer,
        results,
        images: [],
        response_time: elapsedSeconds,
      },
      { status: 200 },
    );
  }

  // ── Serper POST /search | /news ────────────────────────────────────────────
  if (serviceName === 'serper' && (normalizedPath === '/search' || normalizedPath === '/news')) {
    const query = String(json.q ?? json.query ?? '').trim();
    if (!query) {
      return Response.json({ error: 'Missing query' }, { status: 400 });
    }
    const maxResults = Number(json.num ?? 10);
    const topic = normalizedPath === '/news' ? 'news' : 'general';
    const { results, elapsedSeconds } = await searchOpenWeb(query, { maxResults, topic });
    appLogger.info(`[PROXY] serper open-web fallback served ${results.length} results in ${elapsedSeconds}s`);
    const mapped = results.map((r, idx) => ({
      title: r.title,
      link: r.url,
      snippet: r.content,
      date: r.published_date || undefined,
      source: r.source || undefined,
      position: idx + 1,
    }));
    return Response.json(
      {
        searchParameters: { q: query, type: topic },
        ...(normalizedPath === '/news' ? { news: mapped } : { organic: mapped }),
      },
      { status: 200 },
    );
  }

  // ── Firecrawl POST /v1/search | /v2/search ─────────────────────────────────
  if (serviceName === 'firecrawl' && (normalizedPath === '/v1/search' || normalizedPath === '/v2/search')) {
    const query = String(json.query ?? '').trim();
    if (!query) {
      return Response.json({ success: false, error: 'Missing query' }, { status: 400 });
    }
    const limit = Number(json.limit ?? 5);
    const { results, elapsedSeconds } = await searchOpenWeb(query, { maxResults: limit });
    appLogger.info(`[PROXY] firecrawl search open-web fallback served ${results.length} results in ${elapsedSeconds}s`);
    return Response.json(
      {
        success: true,
        data: results.map((r) => ({
          url: r.url,
          title: r.title,
          description: r.content,
          markdown: `# ${r.title}\n\n${r.content}\n\nSource: ${r.url}`,
        })),
      },
      { status: 200 },
    );
  }

  // ── Firecrawl POST /v1/scrape | /v2/scrape ─────────────────────────────────
  if (serviceName === 'firecrawl' && (normalizedPath === '/v1/scrape' || normalizedPath === '/v2/scrape')) {
    const url = String(json.url ?? '').trim();
    if (!url) {
      return Response.json({ success: false, error: 'Missing url' }, { status: 400 });
    }
    const includeHtml = Array.isArray(json.formats) && json.formats.includes('html');
    try {
      const fetched = await fetchPublicPageSafely(url);
      if (fetched.status >= 400) {
        return Response.json(
          {
            success: false,
            error: `Target returned HTTP ${fetched.status}`,
          },
          { status: 200 },
        );
      }
      const isPlain = /^text\/plain|^application\/json/i.test(fetched.contentType);
      const parsed = isPlain
        ? { title: fetched.finalUrl, description: '', markdown: fetched.text.slice(0, MAX_MARKDOWN_CHARS) }
        : htmlToMarkdown(fetched.text);
      appLogger.info(`[PROXY] firecrawl scrape open-web fallback fetched ${parsed.markdown.length} chars (status=${fetched.status})`);
      return Response.json(
        {
          success: true,
          data: {
            markdown: parsed.markdown,
            ...(includeHtml ? { html: fetched.text.slice(0, MAX_MARKDOWN_CHARS) } : {}),
            metadata: {
              title: parsed.title,
              description: parsed.description,
              sourceURL: fetched.finalUrl,
              statusCode: fetched.status,
            },
          },
        },
        { status: 200 },
      );
    } catch (err) {
      if (err instanceof UnsafeEgressError) {
        return Response.json(
          { success: false, error: 'URL not allowed: only public http(s) targets may be fetched' },
          { status: 400 },
        );
      }
      return Response.json(
        { success: false, error: err instanceof Error ? err.message : 'Failed to fetch webpage' },
        { status: 200 },
      );
    }
  }

  return null;
}
