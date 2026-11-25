import { describe, expect, test } from 'bun:test';
import type { SessionLogTurn, ToolCallBlock } from '@kortix/sdk';
import {
  MAX_COMPUTER_STEPS,
  MAX_STEP_LINES,
  MAX_STEP_OUTPUT_CHARS,
  classifyComputerTool,
  deriveComputerDockView,
  deriveComputerState,
  deriveDesktopProxyUrl,
  deriveDesktopScreenshotUrl,
  detectNetworkRestriction,
  extractFirstCommandWord,
  formatComputerSheetCaption,
  getComputerCopy,
  isBrowserShellCommand,
  isLocalhostPreviewUrl,
  resolveComputerStepIndex,
  stripShellEnvPrefix,
  truncateStepText,
} from './computer-steps';

function makeToolCall(overrides: Partial<ToolCallBlock> & { id: string; name: string }): ToolCallBlock {
  return {
    type: 'tool_call',
    call_id: `call_${overrides.id}`,
    kind: 'other',
    input: {},
    status: 'complete',
    result: {
      content: [{ type: 'text', text: '' }],
      is_error: false,
    },
    ...overrides,
  };
}

function makeTurn(id: string, blocks: ToolCallBlock[], live = false): SessionLogTurn {
  return {
    id,
    live,
    blocks,
  } as unknown as SessionLogTurn;
}

describe('computer-steps pure reducer & mapper', () => {
  test('classifies env-prefixed agent-browser, xdg-open, playwright as Browser and other shell as Terminal', () => {
    expect(stripShellEnvPrefix('DISPLAY=:1 AGENT_BROWSER_HEADED=false agent-browser open https://github.com/Simpleyyt/ai-manus')).toBe(
      'agent-browser open https://github.com/Simpleyyt/ai-manus',
    );
    expect(extractFirstCommandWord('NODE_ENV=production git status -s')).toBe('git');

    expect(isBrowserShellCommand('AGENT_BROWSER_HEADED=false agent-browser open https://github.com/Simpleyyt/ai-manus')).toBe(true);
    expect(isBrowserShellCommand('DISPLAY=:1 agent-browser snapshot -i')).toBe(true);
    expect(isBrowserShellCommand('DISPLAY=:1 agent-browser click @e12')).toBe(true);
    expect(isBrowserShellCommand('DISPLAY=:1 agent-browser type @e3 "hello"')).toBe(true);
    expect(isBrowserShellCommand('DISPLAY=:1 agent-browser screenshot /tmp/a.png')).toBe(true);
    expect(isBrowserShellCommand('DISPLAY=:1 agent-browser close')).toBe(true);
    expect(isBrowserShellCommand('DISPLAY=:1 xdg-open https://github.com')).toBe(true);
    expect(isBrowserShellCommand('npx playwright open https://github.com')).toBe(true);
    expect(isBrowserShellCommand('ls -la /workspace')).toBe(false);

    expect(classifyComputerTool('bash', { command: 'ls -la' }, 'shell')).toBe('terminal');
    expect(classifyComputerTool('bash', { command: 'AGENT_BROWSER_HEADED=false agent-browser open https://github.com/Simpleyyt/ai-manus' }, 'shell')).toBe('browser');
    expect(classifyComputerTool('bash', { command: 'DISPLAY=:1 xdg-open https://example.org' }, 'shell')).toBe('browser');
    expect(classifyComputerTool('bash', { command: 'playwright screenshot https://github.com out.png' }, 'shell')).toBe('browser');
    expect(classifyComputerTool('pty_spawn', { command: 'htop' })).toBe('terminal');
    expect(classifyComputerTool('edit', { filePath: '/workspace/app.ts' }, 'edit')).toBe('files');
    expect(classifyComputerTool('web_search', { query: 'daytona docs' }, 'web_search')).toBe('mcp');
    expect(classifyComputerTool('mcp__github__list_issues', { owner: 'kortix' }, 'mcp')).toBe('mcp');
  });

  test('isLocalhostPreviewUrl allows only real local preview servers, never external sites or voxl', () => {
    expect(isLocalhostPreviewUrl('http://localhost:3000')).toBe(true);
    expect(isLocalhostPreviewUrl('http://127.0.0.1:5173/app')).toBe(true);
    expect(isLocalhostPreviewUrl('https://api.example.com/v1/p/ext-123/3000/')).toBe(true);
    expect(isLocalhostPreviewUrl('https://github.com/Simpleyyt/ai-manus')).toBe(false);
    expect(isLocalhostPreviewUrl('https://www.google.com')).toBe(false);
    expect(isLocalhostPreviewUrl('https://api.example.com/v1/p/ext-123/6901/')).toBe(false);
    expect(isLocalhostPreviewUrl('https://api.example.com/v1/p/ext-123/8000')).toBe(false);
  });

  test('extracts browser domain without bash header, humanized details, file diffs, and screenshot URL', () => {
    const turns = [
      makeTurn(
        'turn-1',
        [
          makeToolCall({ id: 'todo-1', name: 'todowrite', input: { todos: [] } }),
          makeToolCall({
            id: 'bash-1',
            name: 'bash',
            kind: 'shell',
            input: { command: 'NODE_ENV=test bun test src/app.test.ts', description: 'bash' },
            result: {
              content: [{ type: 'text', text: '\u001b[32m✓ 4 pass\u001b[0m\n0 fail' }],
              is_error: false,
              exit_code: 0,
            },
          }),
          makeToolCall({
            id: 'browser-1',
            name: 'bash',
            kind: 'shell',
            input: {
              command: 'DISPLAY=:1 AGENT_BROWSER_HEADED=true agent-browser open https://github.com/Simpleyyt/ai-manus && agent-browser get title',
            },
            result: {
              content: [{ type: 'text', text: 'Title: Simpleyyt/ai-manus' }],
              is_error: false,
            },
          }),
          makeToolCall({
            id: 'edit-1',
            name: 'edit',
            kind: 'edit',
            input: {
              filePath: '/workspace/src/index.ts',
              oldString: 'const a = 1;\n',
              newString: 'const a = 2;\nconst b = 3;\n',
            },
            result: { content: [{ type: 'text', text: 'Updated file' }], is_error: false },
          }),
          makeToolCall({
            id: 'mcp-1',
            name: 'mcp__supabase__list_tables',
            kind: 'mcp',
            input: { schemas: ['kortix'] },
            status: 'running',
            result: undefined,
          }),
        ],
        true,
      ),
    ];

    const state = deriveComputerState({
      turns,
      isBusy: true,
      sandboxUrl: 'https://api.example.com/v1/p/ext-123/8000',
    });

    expect(state.status).toBe('working');
    expect(state.steps).toHaveLength(4);
    expect(state.desktopProxyUrl).toBe('https://api.example.com/v1/p/ext-123/6901/');
    expect(state.desktopScreenshotUrl).toBe('https://api.example.com/v1/p/ext-123/6901/screenshot');

    // Terminal never shows raw env vars in humanDetail or "bash" as title
    expect(state.steps[0].surface).toBe('terminal');
    expect(state.steps[0].title).toBe('Terminal');
    expect(state.steps[0].humanDetail).toBe('bun');
    expect(state.steps[0].output.text).toBe('✓ 4 pass\n0 fail');

    // Browser step never shows "bash" header; extracts clean domain
    expect(state.steps[1].surface).toBe('browser');
    expect(state.steps[1].title).toBe('Browser');
    expect(state.steps[1].domain).toBe('github.com');
    expect(state.steps[1].humanDetail).toBe('github.com');
    expect(state.steps[1].pageTitle).toBe('Simpleyyt/ai-manus');

    // Files step exposes basename & real diffLines
    expect(state.steps[2].surface).toBe('files');
    expect(state.steps[2].humanDetail).toBe('index.ts');
    expect(state.steps[2].diffStats).toEqual({ additions: 2, deletions: 1 });
    expect(state.steps[2].diffLines?.some((l) => l.type === 'added' && l.text === 'const b = 3;')).toBe(true);

    // Captions & titles in EN and AR
    expect(getComputerCopy('en').computerTitleFor('My Kortix')).toBe("My Kortix's computer");
    expect(getComputerCopy('ar').computerTitleFor('My Kortix')).toBe('حاسوب My Kortix');
    expect(formatComputerSheetCaption('My Kortix', state.steps[1], 'en')).toBe(
      'My Kortix is using Browser · github.com',
    );
    expect(formatComputerSheetCaption('My Kortix', state.steps[1], 'ar')).toBe(
      'My Kortix يستخدم المتصفح · github.com',
    );
  });

  test('maps dock states, pulsing/semantic dot colors, humanized details, and Daytona plan egress message', () => {
    const cases: Array<{
      name: string;
      call: ToolCallBlock;
      enLabel: string;
      arLabel: string;
      detail: string;
      previewKind: 'terminal' | 'browser' | 'files' | 'mcp' | 'inactive';
    }> = [
      {
        name: 'terminal',
        call: makeToolCall({ id: 't1', name: 'bash', kind: 'shell', input: { command: 'FOO=1 git status' }, status: 'running', result: undefined }),
        enLabel: 'Using Terminal',
        arLabel: 'يستخدم الطرفية',
        detail: 'git',
        previewKind: 'terminal',
      },
      {
        name: 'browser',
        call: makeToolCall({ id: 'b1', name: 'bash', kind: 'shell', input: { command: 'AGENT_BROWSER_HEADED=true agent-browser open https://github.com/Simpleyyt/ai-manus' }, status: 'running', result: undefined }),
        enLabel: 'Using Browser',
        arLabel: 'يستخدم المتصفح',
        detail: 'github.com',
        previewKind: 'browser',
      },
      {
        name: 'files',
        call: makeToolCall({ id: 'f1', name: 'edit', kind: 'edit', input: { filePath: '/workspace/src/app.ts', oldString: 'a', newString: 'b' }, status: 'running', result: undefined }),
        enLabel: 'Editing files',
        arLabel: 'يعدّل الملفات',
        detail: 'app.ts',
        previewKind: 'files',
      },
      {
        name: 'web search',
        call: makeToolCall({ id: 'w1', name: 'web_search', kind: 'web_search', input: { query: 'kortix docs' }, status: 'running', result: undefined }),
        enLabel: 'Searching the web',
        arLabel: 'يبحث في الويب',
        detail: 'kortix docs',
        previewKind: 'mcp',
      },
      {
        name: 'connector',
        call: makeToolCall({ id: 'c1', name: 'kortix_connectors', input: { connector: 'gmail' }, status: 'running', result: undefined }),
        enLabel: 'Using gmail',
        arLabel: 'يستخدم gmail',
        detail: 'gmail',
        previewKind: 'mcp',
      },
    ];

    for (const c of cases) {
      const state = deriveComputerState({
        turns: [makeTurn(`turn-${c.name}`, [c.call], true)],
        isBusy: true,
      });
      const en = deriveComputerDockView(state, 'en');
      const ar = deriveComputerDockView(state, 'ar');
      expect(en.dotColor).toBe('blue');
      expect(en.dotAnimated).toBe(true);
      expect(en.label).toBe(c.enLabel);
      expect(en.detail).toBe(c.detail);
      expect(en.detail).not.toContain('AGENT_BROWSER');
      expect(en.detail).not.toContain('FOO=1');
      expect(en.preview.kind).toBe(c.previewKind);
      expect(ar.label).toBe(c.arLabel);
    }

    // Daytona plan egress restriction reports real host cleanly
    expect(detectNetworkRestriction('curl: (35) Recv failure: Connection reset by peer')).toBe(true);
    const restrictedState = deriveComputerState({
      turns: [
        makeTurn(
          't-net',
          [
            makeToolCall({
              id: 'nr1',
              name: 'bash',
              kind: 'shell',
              input: { command: 'agent-browser open https://www.google.com' },
              result: {
                content: [{ type: 'text', text: '✗ Navigation failed: net::ERR_QUIC_PROTOCOL_ERROR' }],
                is_error: false,
              },
            }),
          ],
          false,
        ),
      ],
      isBusy: false,
    });
    expect(restrictedState.status).toBe('network_restricted');
    expect(restrictedState.restrictedHost).toBe('google.com');
    const restrictedView = deriveComputerDockView(restrictedState, 'en');
    expect(restrictedView.dotColor).toBe('amber');
    expect(restrictedView.detail).toBe('network restricted by your Daytona plan: google.com');
  });

  test('bounds memory on pathological 50,000-line output and >120 steps', () => {
    const hugeOutput = Array.from({ length: 50_000 }, (_, i) => `line ${i}: verbose log`).join('\n');
    const truncated = truncateStepText(hugeOutput);
    expect(truncated.truncated).toBe(true);
    expect(truncated.text.length).toBeLessThanOrEqual(MAX_STEP_OUTPUT_CHARS);
    expect(truncated.lineCount).toBeLessThanOrEqual(MAX_STEP_LINES);

    const manyCalls = Array.from({ length: 155 }, (_, i) =>
      makeToolCall({
        id: `step-${i}`,
        name: 'bash',
        kind: 'shell',
        input: { command: `echo ${i}` },
        result: { content: [{ type: 'text', text: `${i}` }], is_error: false },
      }),
    );

    const state = deriveComputerState({
      turns: [makeTurn('turn-many', manyCalls, false)],
      isBusy: false,
    });
    expect(state.steps).toHaveLength(MAX_COMPUTER_STEPS);
    expect(state.droppedStepsCount).toBe(35);
    expect(resolveComputerStepIndex(state.steps, null).isLive).toBe(true);
    expect(deriveDesktopProxyUrl('https://kortix.example/v1/p/abc/8000/')).toBe('https://kortix.example/v1/p/abc/6901/');
    expect(deriveDesktopScreenshotUrl('https://kortix.example/v1/p/abc/8000/')).toBe('https://kortix.example/v1/p/abc/6901/screenshot');
  });
});
