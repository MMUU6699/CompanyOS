/**
 * Pure state derivation for the Mobile Session Computer (dock + sheet).
 *
 * Maps real `@kortix/sdk` `SessionLogTurn[]` tool calls + sandbox reachability
 * into bounded, UI-ready `ComputerStep` items and a deterministic
 * `ComputerStatus`. Contains zero React or React Native imports so unit tests
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

import { getDiffStats } from './diff-utils';
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

export type ComputerSurface = 'terminal' | 'browser' | 'files' | 'mcp';

export type ComputerStepStatus = 'running' | 'completed' | 'error';

export type ComputerStatus =
  | 'working'
  | 'idle'
  | 'waking'
  | 'stopped'
  | 'error'
  | 'offline'
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
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  // Terminal fields
  command?: string;
  workdir?: string;
  ptyId?: string;
  // Browser fields
  url?: string;
  browserAction?: string;
  // File fields
  filePath?: string;
  fileVerb?: 'read' | 'write' | 'edit' | 'search' | 'list';
  diffStats?: { additions: number; deletions: number };
  // MCP / search / generic fields
  serverName?: string;
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
  desktopProxyUrl: string | null;
}

// ─── Localization & RTL ──────────────────────────────────────────────────────

export interface ComputerCopy {
  isRtl: boolean;
  computerTitle: string;
  working: string;
  idle: string;
  waking: string;
  stopped: string;
  offline: string;
  emptyTitle: string;
  emptyHint: string;
  offlineHint: string;
  stoppedHint: string;
  wakingHint: string;
  tabSteps: string;
  tabTerminal: string;
  tabDesktop: string;
  takeControl: string;
  returnControl: string;
  live: string;
  stepOf: (current: number, total: number) => string;
  stepsCount: (count: number) => string;
  truncatedNotice: (chars: number) => string;
  reconnectDaytona: string;
  openDaytonaBilling: string;
  retry: string;
  runCommandPlaceholder: string;
  run: string;
  openPreview: string;
  desktopUnavailable: string;
  desktopShieldHint: string;
}

const EN_COPY: ComputerCopy = {
  isRtl: false,
  computerTitle: 'Session computer',
  working: 'Working',
  idle: 'Computer ready',
  waking: 'Waking computer…',
  stopped: 'Computer sleeping',
  offline: 'Offline',
  emptyTitle: 'No computer activity yet',
  emptyHint: 'Commands, browser actions, file edits, and tool calls appear here live.',
  offlineHint: 'Reconnect to the network to view live updates and control the computer.',
  stoppedHint: 'Send a message or wake the session to start its cloud computer.',
  wakingHint: 'Starting the sandbox runtime. Queued prompts run automatically once ready.',
  tabSteps: 'Activity',
  tabTerminal: 'Terminal',
  tabDesktop: 'Desktop',
  takeControl: 'Take control',
  returnControl: 'Return control',
  live: 'Live',
  stepOf: (current, total) => `Step ${current} of ${total}`,
  stepsCount: (count) => (count === 1 ? '1 step' : `${count} steps`),
  truncatedNotice: (chars) => `Output truncated (${chars.toLocaleString()} chars omitted)`,
  reconnectDaytona: 'Reconnect Daytona',
  openDaytonaBilling: 'Open Daytona billing',
  retry: 'Retry',
  runCommandPlaceholder: 'Run command in sandbox…',
  run: 'Run',
  openPreview: 'Open preview',
  desktopUnavailable: 'Live desktop is not running on port 6901 yet.',
  desktopShieldHint: 'Read-only preview. Tap Take control to interact.',
};

const AR_COPY: ComputerCopy = {
  isRtl: true,
  computerTitle: 'حاسوب الجلسة',
  working: 'يعمل الآن',
  idle: 'الحاسوب جاهز',
  waking: 'جارٍ تشغيل الحاسوب…',
  stopped: 'الحاسوب متوقف مؤقتاً',
  offline: 'غير متصل',
  emptyTitle: 'لا يوجد نشاط للحاسوب بعد',
  emptyHint: 'ستظهر أوامر الطرفية والمتصفح وتعديلات الملفات والأدوات هنا مباشرة.',
  offlineHint: 'أعد الاتصال بالشبكة لمتابعة التحديثات المباشرة والتحكم بالحاسوب.',
  stoppedHint: 'أرسل رسالة أو أعد تشغيل الجلسة لتشغيل الحاسوب السحابي.',
  wakingHint: 'جارٍ تجهيز بيئة التشغيل. ستعمل الرسائل بالانتظار تلقائياً فور الجاهزية.',
  tabSteps: 'النشاط',
  tabTerminal: 'الطرفية',
  tabDesktop: 'سطح المكتب',
  takeControl: 'التحكم المباشر',
  returnControl: 'إنهاء التحكم',
  live: 'مباشر',
  stepOf: (current, total) => `خطوة ${current} من ${total}`,
  stepsCount: (count) => (count === 1 ? 'خطوة واحدة' : `${count} خطوات`),
  truncatedNotice: (chars) => `تم اختصار المخرجات (أُخفي ${chars} حرفاً)`,
  reconnectDaytona: 'إعادة ربط Daytona',
  openDaytonaBilling: 'فتح فوترة Daytona',
  retry: 'إعادة المحاولة',
  runCommandPlaceholder: 'نفّذ أمراً داخل الحاسوب…',
  run: 'تنفيذ',
  openPreview: 'فتح المعاينة',
  desktopUnavailable: 'سطح المكتب المباشر غير نشط حالياً على المنفذ 6901.',
  desktopShieldHint: 'وضع المشاهدة فقط. اضغط التحكم المباشر للتفاعل.',
};

export function getComputerCopy(locale?: string | null): ComputerCopy {
  if (locale && locale.toLowerCase().startsWith('ar')) return AR_COPY;
  return EN_COPY;
}

// ─── Bounded text helpers ────────────────────────────────────────────────────

/**
 * O(1)-bounded ANSI-clean text truncation. Slices raw input BEFORE running
 * `stripAnsi` or splitting lines so pathological multi-megabyte outputs never
 * stall the JS thread or trigger OOM.
 */
export function truncateStepText(
  raw: string,
  maxChars = MAX_STEP_OUTPUT_CHARS,
  maxLines = MAX_STEP_LINES,
): TruncatedText {
  if (!raw) {
    return { text: '', truncated: false, omittedChars: 0, lineCount: 0 };
  }

  // Slice to 2x maxChars before regex stripping so ANSI escape sequences don't
  // starve visible characters while still bounding regex work strictly.
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
  if (TERMINAL_TOOLS.has(norm) || kind === 'shell') return 'terminal';
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

function parseMcpToolIdentity(rawName: string): { serverName?: string; label: string } {
  const mcpMatch = rawName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcpMatch) {
    return {
      serverName: mcpMatch[1].replace(/_/g, '-'),
      label: mcpMatch[2].replace(/_/g, '.'),
    };
  }
  return {
    label: rawName.replace(/^oc[-_]/, '').replace(/_/g, ' '),
  };
}

function mapStepStatus(call: ToolCallBlock, turnLive: boolean): ComputerStepStatus {
  const raw = toolCallStatus(call);
  if (raw === 'error' || call.result?.is_error) return 'error';
  if (raw === 'completed') return 'completed';
  return turnLive ? 'running' : 'completed';
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
      return {
        id: call.id,
        callId: call.call_id,
        turnId,
        surface,
        toolName: call.name,
        status,
        title: view.title || 'Terminal session',
        subtitle: view.command || 'pty_spawn',
        startedAt: call.started_at,
        endedAt: call.ended_at,
        exitCode,
        command: view.command,
        workdir: view.workdir || undefined,
        ptyId: view.ptyId || undefined,
        output: truncateStepText(rawOut),
        errorText,
      };
    }
    if (normName === 'pty_read') {
      const view = parsePtyReadOutput(rawOut);
      return {
        id: call.id,
        callId: call.call_id,
        turnId,
        surface,
        toolName: call.name,
        status,
        title: 'Terminal output',
        subtitle: view.id ? `PTY ${view.id}` : 'pty_read',
        startedAt: call.started_at,
        endedAt: call.ended_at,
        exitCode,
        ptyId: view.id || undefined,
        output: truncateStepText(view.content),
        errorText,
      };
    }
    if (normName === 'pty_write') {
      const view = ptyWriteView(input);
      return {
        id: call.id,
        callId: call.call_id,
        turnId,
        surface,
        toolName: call.name,
        status,
        title: 'Terminal input',
        subtitle: firstMeaningfulLine(view.ptyInput, 80) || 'pty_write',
        startedAt: call.started_at,
        endedAt: call.ended_at,
        exitCode,
        command: view.ptyInput,
        ptyId: view.ptyId || undefined,
        output: truncateStepText(rawOut),
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

    return {
      id: call.id,
      callId: call.call_id,
      turnId,
      surface,
      toolName: call.name,
      status,
      title: description || 'Terminal',
      subtitle: firstMeaningfulLine(command, 96) || normName,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      exitCode,
      command,
      workdir,
      output: truncateStepText(rawOut),
      errorText,
    };
  }

  if (surface === 'browser') {
    const url =
      (typeof input.url === 'string' && input.url) ||
      (typeof input.uri === 'string' && input.uri) ||
      extractShowUrl(input) ||
      undefined;
    const action =
      (typeof input.action === 'string' && input.action) ||
      (typeof input.command === 'string' && input.command) ||
      normName.replace(/^browser_/, '');

    let hostLabel = url ?? '';
    if (url) {
      try {
        const parsed = new URL(url.startsWith('http') ? url : `http://${url}`);
        hostLabel = parsed.host + (parsed.pathname !== '/' ? parsed.pathname : '');
      } catch {
        hostLabel = url;
      }
    }

    return {
      id: call.id,
      callId: call.call_id,
      turnId,
      surface,
      toolName: call.name,
      status,
      title: call.title || 'Browser',
      subtitle: hostLabel || firstMeaningfulLine(action, 80) || 'Browsing',
      startedAt: call.started_at,
      endedAt: call.ended_at,
      url,
      browserAction: action,
      output: truncateStepText(rawOut),
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
    let bodySource = rawOut;

    if (
      (normName === 'edit' || normName === 'morph_edit') &&
      typeof input.oldString === 'string' &&
      typeof input.newString === 'string'
    ) {
      diffStats = getDiffStats(input.oldString, input.newString);
      if (!bodySource) {
        bodySource = input.newString;
      }
    } else if (normName === 'write' && typeof input.content === 'string' && !bodySource) {
      bodySource = input.content;
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
      startedAt: call.started_at,
      endedAt: call.ended_at,
      filePath: displayPath || undefined,
      fileVerb: verb,
      diffStats,
      output: truncateStepText(bodySource),
      errorText,
    };
  }

  // MCP, web_search, connectors, and generic tools
  const { serverName, label } = parseMcpToolIdentity(call.name);
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
    title: serverName ? `MCP · ${serverName}` : call.title || label,
    subtitle: queryHint ? firstMeaningfulLine(queryHint, 96) : label,
    startedAt: call.started_at,
    endedAt: call.ended_at,
    serverName,
    argsPreview: formatBoundedArgs(input) || undefined,
    output: truncateStepText(rawOut),
    errorText,
  };
}

// ─── Proxy URL & Error Classification ────────────────────────────────────────

/**
 * Derives the authenticated `/p/:externalId/6901/` desktop proxy URL from the
 * session's daemon `sandboxUrl` (`.../p/:externalId/8000`). Never embeds tokens
 * in the URL; callers attach headers via `authenticatedRequest` when trusted.
 */
export function deriveDesktopProxyUrl(sandboxUrl?: string | null): string | null {
  if (!sandboxUrl) return null;
  const trimmed = sandboxUrl.replace(/\/+$/, '');
  const match = trimmed.match(/^(https?:\/\/.+\/p\/[^/]+)\/\d+$/i);
  if (!match) return null;
  return `${match[1]}/6901/`;
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
  const desktopProxyUrl = deriveDesktopProxyUrl(input.sandboxUrl);

  const reach = input.reachability;
  const unreachable = Boolean(reach?.checked && !reach.reachable && reach.connection === 'unreachable');
  const wakingFromProbe = Boolean(
    reach?.checked &&
      !reach.reachable &&
      (reach.connection === 'waking' || reach.connection === 'connecting'),
  );

  if (input.isOffline) {
    return {
      status: 'offline',
      steps,
      droppedStepsCount,
      activeStep,
      activeSurface,
      error: null,
      desktopProxyUrl,
    };
  }

  const error = classifyComputerError(input.connectError, unreachable, input.locale);
  if (error) {
    return {
      status: 'error',
      steps,
      droppedStepsCount,
      activeStep,
      activeSurface,
      error,
      desktopProxyUrl,
    };
  }

  if (wakingFromProbe) {
    return {
      status: 'waking',
      steps,
      droppedStepsCount,
      activeStep,
      activeSurface,
      error: null,
      desktopProxyUrl,
    };
  }

  if (input.sandboxStatus === 'stopped' || input.sandboxStatus === 'archived') {
    return {
      status: 'stopped',
      steps,
      droppedStepsCount,
      activeStep,
      activeSurface,
      error: null,
      desktopProxyUrl,
    };
  }

  if (input.isBusy || hasRunningStep) {
    return {
      status: 'working',
      steps,
      droppedStepsCount,
      activeStep,
      activeSurface,
      error: null,
      desktopProxyUrl,
    };
  }

  if (steps.length === 0) {
    return {
      status: 'empty',
      steps,
      droppedStepsCount: 0,
      activeStep: null,
      activeSurface: 'terminal',
      error: null,
      desktopProxyUrl,
    };
  }

  return {
    status: 'idle',
    steps,
    droppedStepsCount,
    activeStep,
    activeSurface,
    error: null,
    desktopProxyUrl,
  };
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
