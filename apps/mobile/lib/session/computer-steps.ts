/**
 * Pure state derivation for the Mobile Session Computer (dock + sheet).
 *
 * Maps real `@kortix/sdk` `SessionLogTurn[]` tool calls + sandbox reachability
 * into bounded, UI-ready `ComputerStep` items, a deterministic `ComputerStatus`,
 * and a pure `ComputerDockView` (status dot + EN/AR label + humanized detail +
 * live mini-preview). Contains zero React or React Native imports so unit tests
 * execute in milliseconds without native mocks.
 */

import {
  sessionLogOpenCall,
  shouldShowToolPart,
  stripAnsi,
  toolCallError,
  toolCallStatus,
  type SessionConnection,
  type SessionLogTurn,
  type ToolCallBlock,
} from '@kortix/sdk';

import { generateLineDiff, getDiffStats, type DiffLine } from './diff-utils';
import { firstMeaningfulLine, partInput, partMetadata, partOutput } from './tool-part-accessors';
import { parsePtyReadOutput, ptySpawnView, ptyWriteView } from './tools/files-pty';
import { toDisplayPath } from './turn-body';

/** Maximum steps retained in memory for the open thread. */
export const MAX_COMPUTER_STEPS = 120;

/** Hard cap on characters retained per step body before splitting lines. */
export const MAX_STEP_OUTPUT_CHARS = 12_000;

/** Hard cap on lines retained per step body. */
export const MAX_STEP_LINES = 240;

/** Hard cap on serialized JSON argument preview. */
export const MAX_ARGS_PREVIEW_CHARS = 2_400;

/** Hard cap on rendered file diff lines per step. */
export const MAX_STEP_DIFF_LINES = 120;

export type ComputerSurface = 'terminal' | 'browser' | 'files' | 'mcp';

export type ComputerStepStatus = 'running' | 'completed' | 'error';

export type ComputerStatus =
  | 'working'
  | 'idle'
  | 'waking'
  | 'stopped'
  | 'error'
  | 'offline'
  | 'network_restricted'
  | 'empty';

export type ComputerErrorAction = 'reconnect' | 'billing' | 'retry' | 'none';

export interface ComputerErrorView {
  code: string | null;
  title: string;
  message: string;
  action: ComputerErrorAction;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  omittedChars: number;
  lineCount: number;
}

export interface ComputerStep {
  id: string;
  callId: string;
  turnId: string;
  surface: ComputerSurface;
  toolName: string;
  status: ComputerStepStatus;
  title: string;
  subtitle: string;
  /** Humanized single-line detail for dock & captions (domain, filename, first command word — never raw env vars/commands). */
  humanDetail: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  // Terminal fields
  command?: string;
  workdir?: string;
  ptyId?: string;
  previewLines?: string[];
  isComputerAction?: boolean;
  // Browser fields
  url?: string;
  domain?: string;
  pageTitle?: string;
  screenshotUrl?: string;
  browserAction?: string;
  networkRestricted?: boolean;
  restrictedHost?: string;
  // File fields
  filePath?: string;
  fileVerb?: 'read' | 'write' | 'edit' | 'search' | 'list';
  diffStats?: { additions: number; deletions: number };
  diffLines?: DiffLine[];
  // MCP / search / connector fields
  serverName?: string;
  connectorName?: string;
  isWebSearch?: boolean;
  argsPreview?: string;
  // Bounded output & error
  output: TruncatedText;
  errorText: string | null;
}

export interface DeriveComputerStateInput {
  turns: ReadonlyArray<SessionLogTurn>;
  isBusy: boolean;
  isOffline?: boolean;
  sandboxUrl?: string;
  sandboxStatus?: 'running' | 'active' | 'stopped' | 'archived' | 'error' | 'unknown' | null;
  reachability?: {
    checked: boolean;
    reachable: boolean;
    connection: SessionConnection;
  } | null;
  connectError?: {
    title?: string;
    message?: string;
    code?: string;
  } | null;
  locale?: string;
}

export interface ComputerState {
  status: ComputerStatus;
  steps: ComputerStep[];
  droppedStepsCount: number;
  activeStep: ComputerStep | null;
  activeSurface: ComputerSurface;
  error: ComputerErrorView | null;
  networkRestricted: boolean;
  restrictedHost: string | null;
  desktopProxyUrl: string | null;
  desktopScreenshotUrl: string | null;
}

export type ComputerDockDotColor = 'blue' | 'green' | 'grey' | 'amber' | 'red';

export type ComputerDockPreview =
  | { kind: 'terminal'; lines: string[] }
  | { kind: 'browser'; host: string; pageTitle?: string; screenshotUrl?: string; restricted?: boolean }
  | { kind: 'files'; fileName: string; additions?: number; deletions?: number }
  | { kind: 'mcp'; label: string; snippet?: string }
  | {
      kind: 'inactive';
      reason: 'idle' | 'empty' | 'waking' | 'stopped' | 'offline' | 'error' | 'network_restricted';
    };

export interface ComputerDockView {
  dotColor: ComputerDockDotColor;
  dotAnimated: boolean;
  label: string;
  detail: string | null;
  preview: ComputerDockPreview;
}

export type ComputerTranslator = (
  key: string,
  options?: Record<string, string | number>,
) => string;

// ─── Localization & RTL ──────────────────────────────────────────────────────

export interface ComputerCopy {
  isRtl: boolean;
  computerTitle: string;
  computerTitleFor: (agentName?: string | null) => string;
  working: string;
  idle: string;
  readySubtitle: string;
  inactive: string;
  waking: string;
  stopped: string;
  offline: string;
  networkRestricted: string;
  networkRestrictedHost: (host?: string | null) => string;
  networkRestrictedHint: (host?: string | null) => string;
  error: string;
  usingTerminal: string;
  usingBrowser: string;
  usingComputer: string;
  editingFiles: string;
  searchingWeb: string;
  usingConnector: (name: string) => string;
  waitingForInstructions: string;
  emptyTitle: string;
  emptyHint: string;
  offlineHint: string;
  stoppedHint: string;
  wakingHint: string;
  modeLive: string;
  modeSteps: string;
  takeControl: string;
  returnControl: string;
  openFullScreen: string;
  desktopShieldHint: string;
  desktopUnreachableTitle: string;
  desktopUnreachableHint: string;
  reconnect: string;
  detailsShow: string;
  detailsHide: string;
  live: string;
  stepOf: (current: number, total: number) => string;
  stepsCount: (count: number) => string;
  truncatedNotice: (chars: number) => string;
  reconnectDaytona: string;
  openDaytonaBilling: string;
  retry: string;
  openPreview: string;
  argumentsLabel: string;
  resultLabel: string;
  closeLabel: string;
}

const EN_COPY: ComputerCopy = {
  isRtl: false,
  computerTitle: "Kortix's computer",
  computerTitleFor: (name) => `${name && name.trim() ? name.trim() : 'Kortix'}'s computer`,
  working: 'Working',
  idle: 'Idle',
  readySubtitle: 'Computer ready',
  inactive: 'Inactive',
  waking: 'Waking computer',
  stopped: 'Computer sleeping',
  offline: 'Offline',
  networkRestricted: 'Network restricted',
  networkRestrictedHost: (host) =>
    host ? `network restricted by your Daytona plan: ${host}` : 'network restricted by your Daytona plan',
  networkRestrictedHint: (host) =>
    host
      ? `Direct browser access to ${host} is restricted by your Daytona plan. Allowed hosts include github.com, npmjs.org, and pypi.org.`
      : 'Direct browser egress is restricted by your Daytona plan. Allowed hosts include github.com, npmjs.org, and pypi.org.',
  error: 'Error',
  usingTerminal: 'Using Terminal',
  usingBrowser: 'Using Browser',
  usingComputer: 'Using Computer',
  editingFiles: 'Editing files',
  searchingWeb: 'Searching the web',
  usingConnector: (name) => `Using ${name}`,
  waitingForInstructions: 'Waiting for instructions',
  emptyTitle: 'No computer activity yet',
  emptyHint: 'Live browser sessions, terminal commands, file edits, and tool calls appear here.',
  offlineHint: 'Reconnect to the network to view live updates.',
  stoppedHint: 'Send a message or wake the session to start its cloud computer.',
  wakingHint: 'Starting the sandbox runtime. Queued prompts run automatically once ready.',
  modeLive: 'Live view',
  modeSteps: 'Steps',
  takeControl: 'Take control',
  returnControl: 'Return control',
  openFullScreen: 'Open full screen',
  desktopShieldHint: 'Viewing live · tap Take control to interact',
  desktopUnreachableTitle: 'Live desktop is not answering yet',
  desktopUnreachableHint: 'The session desktop may still be starting on port 6901.',
  reconnect: 'Reconnect',
  detailsShow: 'Details',
  detailsHide: 'Hide details',
  live: 'Live',
  stepOf: (current, total) => `Step ${current} of ${total}`,
  stepsCount: (count) => (count === 1 ? '1 step' : `${count} steps`),
  truncatedNotice: (chars) => `Output truncated (${chars.toLocaleString()} chars omitted)`,
  reconnectDaytona: 'Reconnect Daytona',
  openDaytonaBilling: 'Open Daytona billing',
  retry: 'Retry',
  openPreview: 'Open preview',
  argumentsLabel: 'Arguments',
  resultLabel: 'Result',
  closeLabel: 'Close computer',
};

const AR_COPY: ComputerCopy = {
  isRtl: true,
  computerTitle: 'حاسوب Kortix',
  computerTitleFor: (name) => `حاسوب ${name && name.trim() ? name.trim() : 'Kortix'}`,
  working: 'يعمل الآن',
  idle: 'جاهز',
  readySubtitle: 'الحاسوب جاهز',
  inactive: 'غير نشط',
  waking: 'جارٍ تشغيل الحاسوب',
  stopped: 'الحاسوب متوقف مؤقتاً',
  offline: 'غير متصل',
  networkRestricted: 'الشبكة مقيدة',
  networkRestrictedHost: (host) =>
    host ? `الشبكة مقيدة بخطة Daytona الخاصة بك: ${host}` : 'الشبكة مقيدة بخطة Daytona الخاصة بك',
  networkRestrictedHint: (host) =>
    host
      ? `الوصول المباشر من المتصفح إلى ${host} مقيد بخطة Daytona الخاصة بك. النطاقات المسموحة تشمل github.com و npmjs.org و pypi.org.`
      : 'الوصول المباشر للإنترنت مقيد بخطة Daytona الخاصة بك. النطاقات المسموحة تشمل github.com و npmjs.org و pypi.org.',
  error: 'خطأ',
  usingTerminal: 'يستخدم الطرفية',
  usingBrowser: 'يستخدم المتصفح',
  usingComputer: 'يستخدم الحاسوب',
  editingFiles: 'يعدّل الملفات',
  searchingWeb: 'يبحث في الويب',
  usingConnector: (name) => `يستخدم ${name}`,
  waitingForInstructions: 'بانتظار التعليمات',
  emptyTitle: 'لا يوجد نشاط للحاسوب بعد',
  emptyHint: 'ستظهر جلسة المتصفح المباشرة وأوامر الطرفية وتعديلات الملفات هنا.',
  offlineHint: 'أعد الاتصال بالشبكة لمتابعة التحديثات المباشرة.',
  stoppedHint: 'أرسل رسالة أو أعد تشغيل الجلسة لتشغيل الحاسوب السحابي.',
  wakingHint: 'جارٍ تجهيز بيئة التشغيل. ستعمل الرسائل بالانتظار تلقائياً فور الجاهزية.',
  modeLive: 'عرض مباشر',
  modeSteps: 'الخطوات',
  takeControl: 'التحكم المباشر',
  returnControl: 'إنهاء التحكم',
  openFullScreen: 'ملء الشاشة',
  desktopShieldHint: 'مشاهدة مباشرة · اضغط التحكم المباشر للتفاعل',
  desktopUnreachableTitle: 'سطح المكتب المباشر غير متاح حالياً',
  desktopUnreachableHint: 'قد يكون سطح المكتب قيد التشغيل على المنفذ 6901.',
  reconnect: 'إعادة الاتصال',
  detailsShow: 'التفاصيل',
  detailsHide: 'إخفاء التفاصيل',
  live: 'مباشر',
  stepOf: (current, total) => `خطوة ${current} من ${total}`,
  stepsCount: (count) => (count === 1 ? 'خطوة واحدة' : `${count} خطوات`),
  truncatedNotice: (chars) => `تم اختصار المخرجات (أُخفي ${chars} حرفاً)`,
  reconnectDaytona: 'إعادة ربط Daytona',
  openDaytonaBilling: 'فتح فوترة Daytona',
  retry: 'إعادة المحاولة',
  openPreview: 'فتح المعاينة',
  argumentsLabel: 'المدخلات',
  resultLabel: 'النتيجة',
  closeLabel: 'إغلاق الحاسوب',
};

export function getComputerCopy(locale?: string | null): ComputerCopy {
  if (locale && locale.toLowerCase().startsWith('ar')) return AR_COPY;
  return EN_COPY;
}

// ─── Bounded text helpers ────────────────────────────────────────────────────

export function truncateStepText(
  raw: string,
  maxChars = MAX_STEP_OUTPUT_CHARS,
  maxLines = MAX_STEP_LINES,
): TruncatedText {
  if (!raw) {
    return { text: '', truncated: false, omittedChars: 0, lineCount: 0 };
  }

  const preLimit = maxChars * 2;
  const preSliced = raw.length > preLimit ? raw.slice(0, preLimit) : raw;
  const preOmitted = raw.length - preSliced.length;

  const cleaned = stripAnsi(preSliced).replace(/\r\n/g, '\n');
  let working = cleaned;
  let charOmitted = preOmitted;

  if (working.length > maxChars) {
    charOmitted += working.length - maxChars;
    working = working.slice(0, maxChars);
  }

  const lines = working.split('\n');
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines).join('\n');
    charOmitted += working.length - kept.length;
    return {
      text: kept,
      truncated: true,
      omittedChars: Math.max(1, charOmitted),
      lineCount: maxLines,
    };
  }

  return {
    text: working,
    truncated: charOmitted > 0,
    omittedChars: charOmitted,
    lineCount: working ? lines.length : 0,
  };
}

function formatBoundedArgs(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  try {
    const raw = JSON.stringify(input, null, 2);
    if (!raw || raw === '{}') return '';
    if (raw.length <= MAX_ARGS_PREVIEW_CHARS) return raw;
    return `${raw.slice(0, MAX_ARGS_PREVIEW_CHARS)}\n…`;
  } catch {
    return '';
  }
}

// ─── Shell & URL parsing helpers (pure, tested) ──────────────────────────────

/**
 * Strips leading shell env-var assignments (`FOO=bar`, `DISPLAY=:1`,
 * `AGENT_BROWSER_HEADED=false`) and common wrappers (`env`, `nohup`, `timeout 30`)
 * from a shell segment so we identify the real executable reliably.
 */
export function stripShellEnvPrefix(command: string): string {
  let rest = command.trim();
  for (let i = 0; i < 12; i++) {
    // Strip leading VAR=value (quoted or unquoted)
    const envMatch = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+/);
    if (envMatch) {
      rest = rest.slice(envMatch[0].length).trimStart();
      continue;
    }
    const wrapperMatch = rest.match(/^(?:env|nohup|setsid|sudo(?:\s+-\w+)*|timeout(?:\s+\d+[smh]?)?)\s+/i);
    if (wrapperMatch) {
      rest = rest.slice(wrapperMatch[0].length).trimStart();
      continue;
    }
    break;
  }
  return rest;
}

/** Extracts the humanized first command word (never env vars or flags). */
export function extractFirstCommandWord(command: string): string {
  if (!command) return '';
  const segments = command.split(/(?:&&|\|\||;|\n)/);
  for (const seg of segments) {
    const stripped = stripShellEnvPrefix(seg);
    if (!stripped) continue;
    const token = stripped.split(/\s+/)[0] || '';
    const base = token.split('/').pop() || token;
    if (base && !base.startsWith('-')) return base.slice(0, 32);
  }
  return '';
}

const BROWSER_SHELL_BIN_RE = /^(?:agent-browser|xdg-open|exo-open|playwright|npx\s+playwright|kortix-desktop\s+browser)(?:\s|$)/i;
const COMPUTER_DESKTOP_CMD_RE = /(?:^|[\s;&|])(?:kortix-desktop(?:\s+(?:start|stop|status))|xdotool|scrot|xclip)\b/i;
const URL_IN_TEXT_RE = /https?:\/\/[^\s'"<>`]+/i;
const BARE_DOMAIN_RE = /\b(?:open|goto|navigate)\s+([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+(?:\/[^\s'"<>`]*)?)/i;

/** Returns true if any segment of a shell command invokes agent-browser, xdg-open, or playwright. */
export function isBrowserShellCommand(command: string): boolean {
  if (!command) return false;
  const segments = command.split(/(?:&&|\|\||;|\||\n)/);
  for (const seg of segments) {
    const stripped = stripShellEnvPrefix(seg);
    if (BROWSER_SHELL_BIN_RE.test(stripped)) return true;
  }
  return false;
}

function extractBrowserSubcommand(command: string): string | undefined {
  const segments = command.split(/(?:&&|\|\||;|\||\n)/);
  for (const seg of segments) {
    const stripped = stripShellEnvPrefix(seg);
    const m = stripped.match(/^agent-browser\s+([a-z-]+(?:\s+title)?)/i);
    if (m) return m[1].toLowerCase();
    if (/^(?:xdg-open|exo-open)\b/i.test(stripped)) return 'open';
    if (/^(?:npx\s+)?playwright\b/i.test(stripped)) return 'playwright';
    if (/^kortix-desktop\s+browser\b/i.test(stripped)) return 'open';
  }
  return undefined;
}

function extractUrlFromCommand(command: string): string | undefined {
  const full = command.match(URL_IN_TEXT_RE);
  if (full) return full[0].replace(/[),.;]+$/, '');
  const bare = command.match(BARE_DOMAIN_RE);
  if (bare?.[1]) return `https://${bare[1].replace(/[),.;]+$/, '')}`;
  return undefined;
}

export function extractDomainFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./i, '');
  } catch {
    return undefined;
  }
}

/**
 * Returns true ONLY when `url` points to a real local preview server
 * (`localhost`, `127.0.0.1`, `::1`, or a Kortix sandbox preview port URL other
 * than the daemon `:8000` or desktop `:6901`). External sites like github.com
 * return false so misleading "Open preview" buttons never appear on them.
 */
export function isLocalhostPreviewUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `http://${url}`);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return parsed.port !== '6901' && parsed.port !== '8000';
    }
    const proxyPortMatch = parsed.pathname.match(/\/p\/[^/]+\/(\d+)(?:\/|$)/i);
    if (proxyPortMatch) {
      const port = proxyPortMatch[1];
      return port !== '6901' && port !== '8000';
    }
    return false;
  } catch {
    return false;
  }
}

function extractTerminalPreviewLines(command: string | undefined, outputText: string): string[] {
  const lines: string[] = [];
  if (command) {
    const clean = stripShellEnvPrefix(command);
    const cmdLine = firstMeaningfulLine(clean || command, 36);
    if (cmdLine) lines.push(`$ ${cmdLine}`);
  }
  if (outputText) {
    const nonEmpty = outputText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const tail = nonEmpty.slice(-2);
    for (const line of tail) {
      lines.push(line.length > 38 ? `${line.slice(0, 37)}…` : line);
    }
  }
  return lines.slice(-3);
}

// ─── Network restriction & browser extraction helpers ────────────────────────

const NETWORK_RESTRICTION_PATTERNS = [
  /Internet is restricted on Tier/i,
  /restricted by (?:the Daytona tier|your Daytona plan)/i,
  /ERR_QUIC_PROTOCOL_ERROR/i,
  /ERR_CONNECTION_RESET/i,
  /ERR_TUNNEL_CONNECTION_FAILED/i,
  /Connection reset by peer/i,
  /CONNECT tunnel failed/i,
  /Received HTTP code 403 from proxy/i,
  /curl:\s*\((?:35|52|56|7|28)\)/i,
];

export function detectNetworkRestriction(text: string | null | undefined): boolean {
  if (!text) return false;
  return NETWORK_RESTRICTION_PATTERNS.some((pattern) => pattern.test(text));
}

function extractBrowserPageTitle(
  input: Record<string, unknown>,
  meta: Record<string, unknown>,
  outputText: string,
  command?: string,
): string | undefined {
  const metaTitle =
    (typeof meta.pageTitle === 'string' && meta.pageTitle.trim()) ||
    (typeof meta.page_title === 'string' && meta.page_title.trim()) ||
    (typeof input.pageTitle === 'string' && input.pageTitle.trim()) ||
    '';
  if (metaTitle) return metaTitle.slice(0, 120);

  if (!outputText) return undefined;
  const htmlTitle = outputText.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
  if (htmlTitle?.[1]?.trim()) return htmlTitle[1].trim();

  const labeledTitle = outputText.match(/^(?:page\s*)?title\s*:\s*(.+)$/im);
  if (labeledTitle?.[1]?.trim()) return labeledTitle[1].trim().slice(0, 120);

  if (command && /\bagent-browser\b[^\n]*\bget\s+title\b/i.test(command)) {
    const first = firstMeaningfulLine(outputText, 120);
    if (first && !/^error\b/i.test(first) && !/^https?:\/\//i.test(first)) {
      return first;
    }
  }
  return undefined;
}

function extractBrowserScreenshot(
  call: ToolCallBlock,
  meta: Record<string, unknown>,
  outputText: string,
): string | undefined {
  const metaShot =
    (typeof meta.screenshotUrl === 'string' && meta.screenshotUrl) ||
    (typeof meta.screenshot_url === 'string' && meta.screenshot_url) ||
    (typeof meta.imageUrl === 'string' && meta.imageUrl) ||
    undefined;
  if (metaShot && (/^https?:\/\//i.test(metaShot) || /^data:image\//i.test(metaShot))) {
    return metaShot;
  }

  const content = call.result?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as unknown as Record<string, unknown>;
      if (rec.type === 'image') {
        if (typeof rec.url === 'string' && /^https?:\/\//i.test(rec.url)) return rec.url;
        if (typeof rec.data === 'string' && rec.data.length > 0) {
          if (rec.data.startsWith('data:image/')) return rec.data;
          const mime = typeof rec.mimeType === 'string' ? rec.mimeType : 'image/png';
          return `data:${mime};base64,${rec.data}`;
        }
      }
    }
  }

  const dataUri = outputText.match(/data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]{24,}/);
  if (dataUri) return dataUri[0];
  return undefined;
}

// ─── Tool family classification ──────────────────────────────────────────────

const HIDDEN_COMPUTER_TOOLS = new Set([
  'todowrite',
  'todo_write',
  'todoread',
  'todo_read',
  'question',
  'task',
]);

const TERMINAL_TOOLS = new Set([
  'bash',
  'exec',
  'shell',
  'terminal',
  'pty_spawn',
  'pty_read',
  'pty_write',
  'pty_kill',
]);

const BROWSER_TOOLS = new Set([
  'agent_browser',
  'agent-browser',
  'browser',
  'webfetch',
  'web_fetch',
  'scrape',
  'scrape_webpage',
]);

const FILE_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'morph_edit',
  'multiedit',
  'apply_patch',
  'glob',
  'grep',
  'list',
]);

const WEB_SEARCH_TOOLS = new Set([
  'web_search',
  'websearch',
  'image_search',
  'imagesearch',
  'search_web',
]);

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/^oc[-_]/, '');
}

function extractShowUrl(input: Record<string, unknown>): string | undefined {
  const candidate =
    (typeof input.url === 'string' && input.url) ||
    (typeof input.href === 'string' && input.href) ||
    (typeof input.target === 'string' && input.target) ||
    '';
  if (/^https?:\/\//i.test(candidate) || /^localhost:\d+/i.test(candidate)) {
    return candidate;
  }
  return undefined;
}

export function classifyComputerTool(
  toolName: string,
  input: Record<string, unknown>,
  kind?: string,
): ComputerSurface {
  const norm = normalizeToolName(toolName);
  if (TERMINAL_TOOLS.has(norm) || kind === 'shell') {
    const cmd =
      (typeof input.command === 'string' && input.command) ||
      (typeof input.cmd === 'string' && input.cmd) ||
      '';
    if (cmd && isBrowserShellCommand(cmd)) {
      return 'browser';
    }
    return 'terminal';
  }
  if (
    BROWSER_TOOLS.has(norm) ||
    norm.startsWith('browser_') ||
    norm.startsWith('playwright_') ||
    kind === 'web_fetch'
  ) {
    return 'browser';
  }
  if (norm === 'show' && extractShowUrl(input)) {
    return 'browser';
  }
  if (
    FILE_TOOLS.has(norm) ||
    kind === 'read' ||
    kind === 'write' ||
    kind === 'edit' ||
    kind === 'patch' ||
    kind === 'glob' ||
    kind === 'grep' ||
    kind === 'list'
  ) {
    return 'files';
  }
  return 'mcp';
}

function parseMcpToolIdentity(
  rawName: string,
  input: Record<string, unknown>,
): { serverName?: string; connectorName?: string; label: string; isWebSearch: boolean } {
  const norm = normalizeToolName(rawName);
  const isWebSearch = WEB_SEARCH_TOOLS.has(norm);
  const mcpMatch = rawName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcpMatch) {
    const serverName = mcpMatch[1].replace(/_/g, '-');
    return {
      serverName,
      connectorName: serverName,
      label: mcpMatch[2].replace(/_/g, '.'),
      isWebSearch,
    };
  }
  if (norm === 'kortix_connectors' || norm.startsWith('connector_')) {
    const slug =
      (typeof input.connector === 'string' && input.connector) ||
      (typeof input.slug === 'string' && input.slug) ||
      (typeof input.app === 'string' && input.app) ||
      (typeof input.provider === 'string' && input.provider) ||
      undefined;
    return {
      connectorName: slug || 'Connectors',
      label: rawName.replace(/^oc[-_]/, '').replace(/_/g, ' '),
      isWebSearch: false,
    };
  }
  return {
    label: rawName.replace(/^oc[-_]/, '').replace(/_/g, ' '),
    isWebSearch,
  };
}

function mapStepStatus(call: ToolCallBlock, turnLive: boolean): ComputerStepStatus {
  const raw = toolCallStatus(call);
  if (raw === 'error' || call.result?.is_error) return 'error';
  if (raw === 'completed') return 'completed';
  return turnLive ? 'running' : 'completed';
}

function formatHostPathLabel(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./i, '') + (parsed.pathname !== '/' ? parsed.pathname : '');
  } catch {
    return url;
  }
}

function humanizeBrowserAction(action?: string): string {
  switch ((action || '').toLowerCase()) {
    case 'open':
    case 'goto':
    case 'navigate':
      return 'Opening page';
    case 'click':
      return 'Clicking element';
    case 'type':
    case 'fill':
      return 'Typing in page';
    case 'snapshot':
      return 'Reading page';
    case 'screenshot':
      return 'Capturing view';
    case 'get title':
      return 'Reading title';
    case 'close':
      return 'Closing browser';
    default:
      return 'Browsing';
  }
}

export function extractComputerStep(
  rawCall: ToolCallBlock,
  turnId: string,
  turnLive: boolean,
): ComputerStep | null {
  const normName = normalizeToolName(rawCall.name);
  if (HIDDEN_COMPUTER_TOOLS.has(normName)) return null;
  if (!shouldShowToolPart(rawCall)) return null;

  const call = sessionLogOpenCall(rawCall);
  const input = partInput(call);
  const meta = partMetadata(call);
  const surface = classifyComputerTool(call.name, input, call.kind);
  const status = mapStepStatus(call, turnLive);
  const rawErr = toolCallError(call);
  const errorText = rawErr ? stripAnsi(rawErr).slice(0, 2_000) : null;
  const exitCode =
    typeof call.result?.exit_code === 'number'
      ? call.result.exit_code
      : typeof meta.exit === 'number'
        ? meta.exit
        : undefined;

  const rawOut = partOutput(call);

  if (surface === 'terminal') {
    if (normName === 'pty_spawn') {
      const view = ptySpawnView(input, rawOut);
      const output = truncateStepText(rawOut);
      const firstWord = extractFirstCommandWord(view.command || '');
      return {
        id: call.id,
        callId: call.call_id,
        turnId,
        surface,
        toolName: call.name,
        status,
        title: view.title || 'Terminal',
        subtitle: view.command || 'pty_spawn',
        humanDetail: firstWord || 'shell',
        startedAt: call.started_at,
        endedAt: call.ended_at,
        exitCode,
        command: view.command,
        workdir: view.workdir || undefined,
        ptyId: view.ptyId || undefined,
        previewLines: extractTerminalPreviewLines(view.command, output.text),
        isComputerAction: COMPUTER_DESKTOP_CMD_RE.test(view.command || ''),
        output,
        errorText,
      };
    }
    if (normName === 'pty_read') {
      const view = parsePtyReadOutput(rawOut);
      const output = truncateStepText(view.content);
      return {
        id: call.id,
        callId: call.call_id,
        turnId,
        surface,
        toolName: call.name,
        status,
        title: 'Terminal',
        subtitle: view.id ? `PTY ${view.id}` : 'Terminal output',
        humanDetail: 'terminal',
        startedAt: call.started_at,
        endedAt: call.ended_at,
        exitCode,
        ptyId: view.id || undefined,
        previewLines: extractTerminalPreviewLines(undefined, output.text),
        output,
        errorText,
      };
    }
    if (normName === 'pty_write') {
      const view = ptyWriteView(input);
      const output = truncateStepText(rawOut);
      const firstWord = extractFirstCommandWord(view.ptyInput || '');
      return {
        id: call.id,
        callId: call.call_id,
        turnId,
        surface,
        toolName: call.name,
        status,
        title: 'Terminal',
        subtitle: firstMeaningfulLine(view.ptyInput, 80) || 'Terminal input',
        humanDetail: firstWord || 'terminal',
        startedAt: call.started_at,
        endedAt: call.ended_at,
        exitCode,
        command: view.ptyInput,
        ptyId: view.ptyId || undefined,
        previewLines: extractTerminalPreviewLines(view.ptyInput, output.text),
        output,
        errorText,
      };
    }

    const command =
      (typeof input.command === 'string' && input.command) ||
      (typeof input.cmd === 'string' && input.cmd) ||
      '';
    const description =
      (typeof input.description === 'string' && input.description) || call.title || '';
    const workdir =
      (typeof input.workdir === 'string' && input.workdir) ||
      (typeof input.cwd === 'string' && input.cwd) ||
      undefined;
    const output = truncateStepText(rawOut);
    const networkRestricted =
      detectNetworkRestriction(errorText) || detectNetworkRestriction(output.text);
    const restrictedUrl = networkRestricted ? extractUrlFromCommand(command) : undefined;
    const restrictedHost = restrictedUrl ? extractDomainFromUrl(restrictedUrl) : undefined;
    const firstWord = extractFirstCommandWord(command);

    return {
      id: call.id,
      callId: call.call_id,
      turnId,
      surface,
      toolName: call.name,
      status,
      title: description && !/^bash$/i.test(description) ? description : 'Terminal',
      subtitle: firstMeaningfulLine(command, 96) || 'shell',
      humanDetail: firstWord || 'shell',
      startedAt: call.started_at,
      endedAt: call.ended_at,
      exitCode,
      command,
      workdir,
      previewLines: extractTerminalPreviewLines(command, output.text),
      isComputerAction: COMPUTER_DESKTOP_CMD_RE.test(command),
      networkRestricted,
      restrictedHost,
      output,
      errorText,
    };
  }

  if (surface === 'browser') {
    const command =
      (typeof input.command === 'string' && input.command) ||
      (typeof input.cmd === 'string' && input.cmd) ||
      undefined;
    const url =
      (typeof input.url === 'string' && input.url) ||
      (typeof input.urls === 'string' && input.urls) ||
      (typeof input.uri === 'string' && input.uri) ||
      extractShowUrl(input) ||
      (command ? extractUrlFromCommand(command) : undefined);
    const domain = extractDomainFromUrl(url);
    const action =
      (typeof input.action === 'string' && input.action) ||
      (command ? extractBrowserSubcommand(command) : undefined) ||
      normName.replace(/^browser_/, '');

    const output = truncateStepText(rawOut);
    const pageTitle = extractBrowserPageTitle(input, meta, output.text, command);
    const screenshotUrl = extractBrowserScreenshot(call, meta, rawOut);
    const networkRestricted =
      detectNetworkRestriction(errorText) || detectNetworkRestriction(output.text);
    const hostPath = url ? formatHostPathLabel(url) : '';
    const humanDetail = domain || pageTitle || humanizeBrowserAction(action);

    return {
      id: call.id,
      callId: call.call_id,
      turnId,
      surface,
      toolName: call.name,
      status,
      // Never leak "bash" as the header title for a Browser step.
      title: 'Browser',
      subtitle: hostPath || pageTitle || humanizeBrowserAction(action),
      humanDetail,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      exitCode,
      command,
      url,
      domain,
      pageTitle,
      screenshotUrl,
      browserAction: action,
      networkRestricted,
      restrictedHost: networkRestricted ? domain : undefined,
      output,
      errorText,
    };
  }

  if (surface === 'files') {
    const rawPath =
      (typeof input.filePath === 'string' && input.filePath) ||
      (typeof input.file_path === 'string' && input.file_path) ||
      (typeof input.path === 'string' && input.path) ||
      (typeof input.pattern === 'string' && input.pattern) ||
      '';
    const displayPath = rawPath ? toDisplayPath(rawPath) : '';
    const fileName = displayPath ? displayPath.split('/').pop() || displayPath : normName;

    const verb: ComputerStep['fileVerb'] =
      normName === 'read'
        ? 'read'
        : normName === 'write'
          ? 'write'
          : normName === 'glob' || normName === 'grep'
            ? 'search'
            : normName === 'list'
              ? 'list'
              : 'edit';

    let diffStats: { additions: number; deletions: number } | undefined;
    let diffLines: DiffLine[] | undefined;
    let bodySource = rawOut;

    if (
      (normName === 'edit' || normName === 'morph_edit') &&
      typeof input.oldString === 'string' &&
      typeof input.newString === 'string'
    ) {
      diffStats = getDiffStats(input.oldString, input.newString);
      diffLines = generateLineDiff(input.oldString, input.newString).slice(0, MAX_STEP_DIFF_LINES);
      if (!bodySource) {
        bodySource = input.newString;
      }
    } else if (normName === 'write' && typeof input.content === 'string') {
      const lines = input.content.split('\n');
      diffStats = { additions: lines.length, deletions: 0 };
      if (!bodySource) {
        bodySource = input.content;
      }
    } else if (normName === 'apply_patch' && typeof input.patch === 'string' && !bodySource) {
      bodySource = input.patch;
    }

    const titleByVerb: Record<NonNullable<ComputerStep['fileVerb']>, string> = {
      read: 'Read file',
      write: 'Write file',
      edit: 'Edit file',
      search: 'Search files',
      list: 'List directory',
    };

    return {
      id: call.id,
      callId: call.call_id,
      turnId,
      surface,
      toolName: call.name,
      status,
      title: call.title || titleByVerb[verb],
      subtitle: displayPath || normName,
      humanDetail: fileName,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      filePath: displayPath || undefined,
      fileVerb: verb,
      diffStats,
      diffLines,
      output: truncateStepText(bodySource),
      errorText,
    };
  }

  // MCP, web_search, connectors, and generic tools
  const { serverName, connectorName, label, isWebSearch } = parseMcpToolIdentity(call.name, input);
  const queryHint =
    (typeof input.query === 'string' && input.query) ||
    (typeof input.q === 'string' && input.q) ||
    '';

  return {
    id: call.id,
    callId: call.call_id,
    turnId,
    surface: 'mcp',
    toolName: call.name,
    status,
    title: serverName ? `Tool · ${serverName}` : call.title || label,
    subtitle: queryHint ? firstMeaningfulLine(queryHint, 96) : label,
    humanDetail: queryHint
      ? firstMeaningfulLine(queryHint, 48)
      : connectorName || serverName || label,
    startedAt: call.started_at,
    endedAt: call.ended_at,
    serverName,
    connectorName,
    isWebSearch,
    argsPreview: formatBoundedArgs(input) || undefined,
    output: truncateStepText(rawOut),
    errorText,
  };
}

// ─── Proxy URLs & Error Classification ───────────────────────────────────────

export function deriveDesktopProxyUrl(sandboxUrl?: string | null): string | null {
  if (!sandboxUrl) return null;
  const trimmed = sandboxUrl.replace(/\/+$/, '');
  const match = trimmed.match(/^(https?:\/\/.+\/p\/[^/]+)\/\d+$/i);
  if (!match) return null;
  return `${match[1]}/6901/`;
}

export function deriveDesktopScreenshotUrl(sandboxUrl?: string | null): string | null {
  const base = deriveDesktopProxyUrl(sandboxUrl);
  return base ? `${base}screenshot` : null;
}

export function classifyComputerError(
  connectError: DeriveComputerStateInput['connectError'],
  unreachable: boolean,
  locale?: string,
): ComputerErrorView | null {
  const isAr = Boolean(locale && locale.toLowerCase().startsWith('ar'));
  if (connectError) {
    const code = connectError.code ?? null;
    if (code === 'DAYTONA_ORG_SUSPENDED') {
      return {
        code,
        title: connectError.title || (isAr ? 'توقفت مساحة Daytona مؤقتاً' : 'Daytona workspace suspended'),
        message:
          connectError.message ||
          (isAr
            ? 'نفد رصيد مساحة Daytona الخاصة بك. أضف رصيداً في لوحة Daytona أو اربط حساباً آخر.'
            : 'Your Daytona workspace ran out of credits. Add credits in Daytona or connect a different account.'),
        action: 'billing',
      };
    }
    if (code === 'DAYTONA_RECONNECT_REQUIRED' || code === 'DAYTONA_NOT_CONNECTED') {
      return {
        code,
        title: connectError.title || (isAr ? 'يلزم إعادة ربط Daytona' : 'Daytona reconnect required'),
        message:
          connectError.message ||
          (isAr
            ? 'انتهت صلاحية مفتاح Daytona الخاص بك أو تم إلغاؤه. أعد الربط للمتابعة.'
            : 'Your Daytona credentials are missing or revoked. Reconnect your Daytona account to continue.'),
        action: 'reconnect',
      };
    }
    if (code === 'DAYTONA_QUOTA_EXCEEDED') {
      return {
        code,
        title: connectError.title || (isAr ? 'تم الوصول إلى حد موارد Daytona' : 'Daytona capacity limit reached'),
        message:
          connectError.message ||
          (isAr
            ? 'وصلت مساحة Daytona إلى الحد الأقصى للحواسيب النشطة أو القرص.'
            : 'Your Daytona organization reached its active memory or disk quota.'),
        action: 'billing',
      };
    }
    return {
      code,
      title: connectError.title || (isAr ? 'تعذّر تشغيل الحاسوب' : 'Computer error'),
      message:
        connectError.message ||
        (isAr ? 'تعذّر الوصول إلى حاسوب هذه الجلسة.' : 'Could not start or reach this session computer.'),
      action: 'retry',
    };
  }

  if (unreachable) {
    return {
      code: 'SANDBOX_UNREACHABLE',
      title: isAr ? 'تعذّر الوصول إلى الحاسوب' : "Can't reach computer",
      message: isAr
        ? 'انقطع الاتصال بحاسوب الجلسة. تحقّق من الشبكة أو أعد المحاولة.'
        : 'The session computer did not answer health checks. Retry or check session status.',
      action: 'retry',
    };
  }

  return null;
}

// ─── Main Pure Reducer ───────────────────────────────────────────────────────

export function deriveComputerState(input: DeriveComputerStateInput): ComputerState {
  const allSteps: ComputerStep[] = [];
  let hasRunningStep = false;

  for (let ti = 0; ti < input.turns.length; ti++) {
    const turn = input.turns[ti];
    const turnLive = Boolean(turn.live);
    for (let bi = 0; bi < turn.blocks.length; bi++) {
      const block = turn.blocks[bi];
      if (block.type !== 'tool_call') continue;
      const step = extractComputerStep(block, turn.id, turnLive);
      if (!step) continue;
      if (step.status === 'running') hasRunningStep = true;
      allSteps.push(step);
    }
  }

  const droppedStepsCount = Math.max(0, allSteps.length - MAX_COMPUTER_STEPS);
  const steps = droppedStepsCount > 0 ? allSteps.slice(allSteps.length - MAX_COMPUTER_STEPS) : allSteps;
  const activeStep = steps.length > 0 ? steps[steps.length - 1] : null;
  const activeSurface: ComputerSurface = activeStep?.surface ?? 'terminal';
  const networkRestricted = Boolean(activeStep?.networkRestricted);
  const restrictedHost = activeStep?.restrictedHost ?? null;
  const desktopProxyUrl = deriveDesktopProxyUrl(input.sandboxUrl);
  const desktopScreenshotUrl = deriveDesktopScreenshotUrl(input.sandboxUrl);

  const reach = input.reachability;
  const unreachable = Boolean(reach?.checked && !reach.reachable && reach.connection === 'unreachable');
  const wakingFromProbe = Boolean(
    reach?.checked &&
      !reach.reachable &&
      (reach.connection === 'waking' || reach.connection === 'connecting'),
  );

  const base = {
    steps,
    droppedStepsCount,
    activeStep,
    activeSurface,
    networkRestricted,
    restrictedHost,
    desktopProxyUrl,
    desktopScreenshotUrl,
  };

  if (input.isOffline) {
    return { ...base, status: 'offline', error: null };
  }

  const error = classifyComputerError(input.connectError, unreachable, input.locale);
  if (error) {
    return { ...base, status: 'error', error };
  }

  if (wakingFromProbe) {
    return { ...base, status: 'waking', error: null };
  }

  if (input.sandboxStatus === 'stopped' || input.sandboxStatus === 'archived') {
    return { ...base, status: 'stopped', error: null };
  }

  if (input.isBusy || hasRunningStep) {
    return { ...base, status: 'working', error: null };
  }

  if (networkRestricted) {
    return { ...base, status: 'network_restricted', error: null, networkRestricted: true };
  }

  if (steps.length === 0) {
    return {
      ...base,
      status: 'empty',
      droppedStepsCount: 0,
      activeStep: null,
      activeSurface: 'terminal',
      error: null,
      networkRestricted: false,
      restrictedHost: null,
    };
  }

  return { ...base, status: 'idle', error: null, networkRestricted: false, restrictedHost: null };
}

// ─── Pure Dock View Mapper + Sheet Captions ──────────────────────────────────

function translate(
  locale: string | null | undefined,
  t: ComputerTranslator | undefined,
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  if (locale && locale.toLowerCase().startsWith('ar')) {
    return fallback;
  }
  if (!t) return fallback;
  const resolved = t(key, params);
  return resolved && resolved !== key ? resolved : fallback;
}

export function mapActiveStepLabel(
  step: ComputerStep | null,
  locale?: string | null,
  t?: ComputerTranslator,
): string {
  const copy = getComputerCopy(locale);
  if (!step) {
    return translate(locale, t, 'computer.working', copy.working);
  }
  if (step.surface === 'browser') {
    return translate(locale, t, 'computer.usingBrowser', copy.usingBrowser);
  }
  if (step.surface === 'files') {
    return translate(locale, t, 'computer.editingFiles', copy.editingFiles);
  }
  if (step.surface === 'terminal') {
    if (step.isComputerAction) {
      return translate(locale, t, 'computer.usingComputer', copy.usingComputer);
    }
    return translate(locale, t, 'computer.usingTerminal', copy.usingTerminal);
  }
  if (step.isWebSearch) {
    return translate(locale, t, 'computer.searchingWeb', copy.searchingWeb);
  }
  const connector = step.connectorName || step.serverName;
  if (connector) {
    return translate(locale, t, 'computer.usingConnector', copy.usingConnector(connector), {
      name: connector,
    });
  }
  return translate(locale, t, 'computer.usingComputer', copy.usingComputer);
}

export function formatComputerSheetCaption(
  agentName: string | null | undefined,
  step: ComputerStep | null,
  locale?: string | null,
): string {
  const copy = getComputerCopy(locale);
  const name = agentName && agentName.trim() ? agentName.trim() : 'Kortix';
  if (!step) return copy.waitingForInstructions;

  const isAr = copy.isRtl;
  let actionText: string;
  if (step.surface === 'browser') {
    actionText = isAr ? `${name} يستخدم المتصفح` : `${name} is using Browser`;
  } else if (step.surface === 'files') {
    actionText = isAr ? `${name} يعدّل الملفات` : `${name} is editing files`;
  } else if (step.surface === 'terminal') {
    actionText = isAr ? `${name} يستخدم الطرفية` : `${name} is using Terminal`;
  } else if (step.isWebSearch) {
    actionText = isAr ? `${name} يبحث في الويب` : `${name} is searching the web`;
  } else {
    const tool = step.connectorName || step.serverName || 'Tool';
    actionText = isAr ? `${name} يستخدم ${tool}` : `${name} is using ${tool}`;
  }

  return step.humanDetail ? `${actionText} · ${step.humanDetail}` : actionText;
}

function buildMiniPreview(state: ComputerState, liveScreenshotUri?: string | null): ComputerDockPreview {
  if (
    state.status === 'offline' ||
    state.status === 'error' ||
    state.status === 'waking' ||
    state.status === 'stopped' ||
    state.status === 'empty'
  ) {
    return { kind: 'inactive', reason: state.status };
  }

  const step = state.activeStep;
  if (!step) {
    return {
      kind: 'inactive',
      reason: state.status === 'network_restricted' ? 'network_restricted' : 'idle',
    };
  }

  if (step.surface === 'terminal') {
    const lines =
      step.previewLines && step.previewLines.length > 0
        ? step.previewLines
        : extractTerminalPreviewLines(step.command, step.output.text);
    return { kind: 'terminal', lines: lines.length > 0 ? lines : ['$ _'] };
  }

  if (step.surface === 'browser') {
    return {
      kind: 'browser',
      host: step.domain || step.humanDetail || 'browser',
      pageTitle: step.pageTitle,
      screenshotUrl: liveScreenshotUri || step.screenshotUrl,
      restricted: Boolean(step.networkRestricted),
    };
  }

  if (step.surface === 'files') {
    return {
      kind: 'files',
      fileName: step.humanDetail || 'file',
      additions: step.diffStats?.additions,
      deletions: step.diffStats?.deletions,
    };
  }

  return {
    kind: 'mcp',
    label: step.connectorName || step.serverName || (step.isWebSearch ? 'web' : step.title),
    snippet: step.humanDetail,
  };
}

export function deriveComputerDockView(
  state: ComputerState,
  locale?: string | null,
  t?: ComputerTranslator,
  liveScreenshotUri?: string | null,
): ComputerDockView {
  const copy = getComputerCopy(locale);
  const preview = buildMiniPreview(state, liveScreenshotUri);

  switch (state.status) {
    case 'working':
      return {
        dotColor: 'blue',
        dotAnimated: true,
        label: mapActiveStepLabel(state.activeStep, locale, t),
        detail: state.activeStep?.humanDetail ?? null,
        preview,
      };
    case 'network_restricted':
      return {
        dotColor: 'amber',
        dotAnimated: false,
        label: translate(locale, t, 'computer.networkRestricted', copy.networkRestricted),
        detail: copy.networkRestrictedHost(state.restrictedHost),
        preview,
      };
    case 'waking':
      return {
        dotColor: 'amber',
        dotAnimated: false,
        label: translate(locale, t, 'computer.waking', copy.waking),
        detail: copy.readySubtitle,
        preview,
      };
    case 'error':
      return {
        dotColor: 'red',
        dotAnimated: false,
        label: state.error?.title || translate(locale, t, 'computer.error', copy.error),
        detail: state.error?.message ?? null,
        preview,
      };
    case 'offline':
      return {
        dotColor: 'grey',
        dotAnimated: false,
        label: translate(locale, t, 'computer.offline', copy.offline),
        detail: copy.offlineHint,
        preview,
      };
    case 'stopped':
      return {
        dotColor: 'grey',
        dotAnimated: false,
        label: translate(locale, t, 'computer.inactive', copy.inactive),
        detail: copy.stopped,
        preview,
      };
    case 'empty':
      return {
        dotColor: 'grey',
        dotAnimated: false,
        label: translate(locale, t, 'computer.idle', copy.idle),
        detail: copy.readySubtitle,
        preview,
      };
    case 'idle':
    default:
      return {
        dotColor: 'green',
        dotAnimated: false,
        label: translate(locale, t, 'computer.idle', copy.idle),
        detail: state.activeStep?.humanDetail ?? copy.readySubtitle,
        preview,
      };
  }
}

/**
 * Resolves the viewed step index for the timeline scrubber.
 * When `selectedStepId` is null (`live` mode), pins to `steps.length - 1`.
 */
export function resolveComputerStepIndex(
  steps: ReadonlyArray<ComputerStep>,
  selectedStepId: string | null,
): { index: number; isLive: boolean; step: ComputerStep | null } {
  if (steps.length === 0) {
    return { index: -1, isLive: true, step: null };
  }
  if (!selectedStepId) {
    const last = steps.length - 1;
    return { index: last, isLive: true, step: steps[last] };
  }
  const found = steps.findIndex((s) => s.id === selectedStepId);
  if (found < 0 || found === steps.length - 1) {
    const last = steps.length - 1;
    return { index: last, isLive: true, step: steps[last] };
  }
  return { index: found, isLive: false, step: steps[found] };
}
