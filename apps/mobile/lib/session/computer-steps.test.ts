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
  detectNetworkRestriction,
  getComputerCopy,
  resolveComputerStepIndex,
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

describe('computer-steps pure reducer', () => {
  test('classifies terminal, browser (including bash agent-browser), files, and mcp tool families', () => {
    expect(classifyComputerTool('bash', { command: 'ls -la' }, 'shell')).toBe('terminal');
    expect(classifyComputerTool('bash', { command: 'DISPLAY=:1 agent-browser open https://www.google.com' }, 'shell')).toBe('browser');
    expect(classifyComputerTool('pty_spawn', { command: 'htop' })).toBe('terminal');
    expect(classifyComputerTool('agent_browser', { url: 'https://example.com' })).toBe('browser');
    expect(classifyComputerTool('scrape_webpage', { url: 'https://kortix.com' })).toBe('browser');
    expect(classifyComputerTool('show', { url: 'http://localhost:8080/' })).toBe('browser');
    expect(classifyComputerTool('edit', { filePath: '/workspace/app.ts' }, 'edit')).toBe('files');
    expect(classifyComputerTool('grep', { pattern: 'TODO' }, 'grep')).toBe('files');
    expect(classifyComputerTool('web_search', { query: 'daytona docs' }, 'web_search')).toBe('mcp');
    expect(classifyComputerTool('mcp__github__list_issues', { owner: 'kortix' }, 'mcp')).toBe('mcp');
  });

  test('extracts terminal, browser title/screenshot, file line diff, and MCP steps while hiding internal calls', () => {
    const turns = [
      makeTurn(
        'turn-1',
        [
          makeToolCall({
            id: 'todo-1',
            name: 'todowrite',
            input: { todos: [] },
          }),
          makeToolCall({
            id: 'bash-1',
            name: 'bash',
            kind: 'shell',
            input: { command: 'bun test src/app.test.ts', description: 'Run unit tests', cwd: '/workspace' },
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
            input: { command: 'AGENT_BROWSER_HEADED=false agent-browser open https://www.google.com && agent-browser get title' },
            result: {
              content: [
                { type: 'text', text: 'Title: Google' },
                { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk', mimeType: 'image/png' } as unknown as { type: 'text'; text: string },
              ],
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
            result: {
              content: [{ type: 'text', text: 'Updated file' }],
              is_error: false,
            },
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

    expect(state.steps[0].surface).toBe('terminal');
    expect(state.steps[0].output.text).toBe('✓ 4 pass\n0 fail');
    expect(state.steps[0].previewLines).toEqual(['$ bun test src/app.test.ts', '✓ 4 pass', '0 fail']);
    expect(state.steps[0].exitCode).toBe(0);

    expect(state.steps[1].surface).toBe('browser');
    expect(state.steps[1].url).toBe('https://www.google.com');
    expect(state.steps[1].pageTitle).toBe('Google');
    expect(state.steps[1].screenshotUrl).toMatch(/^data:image\/png;base64,/);

    expect(state.steps[2].surface).toBe('files');
    expect(state.steps[2].diffStats).toEqual({ additions: 2, deletions: 1 });
    expect(state.steps[2].diffLines?.some((l) => l.type === 'removed' && l.text === 'const a = 1;')).toBe(true);
    expect(state.steps[2].diffLines?.some((l) => l.type === 'added' && l.text === 'const b = 3;')).toBe(true);

    expect(state.steps[3].surface).toBe('mcp');
    expect(state.steps[3].serverName).toBe('supabase');
    expect(state.steps[3].status).toBe('running');
    expect(state.activeSurface).toBe('mcp');
  });

  test('maps dock dot color, animation, preview, and EN/AR labels across all tool surfaces and statuses', () => {
    const cases: Array<{
      name: string;
      call: ToolCallBlock;
      enLabel: string;
      arLabel: string;
      previewKind: 'terminal' | 'browser' | 'files' | 'mcp' | 'inactive';
    }> = [
      {
        name: 'terminal',
        call: makeToolCall({ id: 't1', name: 'bash', kind: 'shell', input: { command: 'ls -la' }, status: 'running', result: undefined }),
        enLabel: 'Using Terminal',
        arLabel: 'يستخدم الطرفية',
        previewKind: 'terminal',
      },
      {
        name: 'computer desktop',
        call: makeToolCall({ id: 't2', name: 'bash', kind: 'shell', input: { command: 'kortix-desktop status' }, status: 'running', result: undefined }),
        enLabel: 'Using Computer',
        arLabel: 'يستخدم الحاسوب',
        previewKind: 'terminal',
      },
      {
        name: 'browser',
        call: makeToolCall({ id: 'b1', name: 'bash', kind: 'shell', input: { command: 'agent-browser open https://www.google.com' }, status: 'running', result: undefined }),
        enLabel: 'Using Browser',
        arLabel: 'يستخدم المتصفح',
        previewKind: 'browser',
      },
      {
        name: 'files',
        call: makeToolCall({ id: 'f1', name: 'edit', kind: 'edit', input: { filePath: '/workspace/app.ts', oldString: 'a', newString: 'b' }, status: 'running', result: undefined }),
        enLabel: 'Editing files',
        arLabel: 'يعدّل الملفات',
        previewKind: 'files',
      },
      {
        name: 'web search',
        call: makeToolCall({ id: 'w1', name: 'web_search', kind: 'web_search', input: { query: 'kortix' }, status: 'running', result: undefined }),
        enLabel: 'Searching the web',
        arLabel: 'يبحث في الويب',
        previewKind: 'mcp',
      },
      {
        name: 'connector',
        call: makeToolCall({ id: 'c1', name: 'kortix_connectors', input: { connector: 'gmail' }, status: 'running', result: undefined }),
        enLabel: 'Using gmail',
        arLabel: 'يستخدم gmail',
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
      expect(en.preview.kind).toBe(c.previewKind);
      expect(ar.label).toBe(c.arLabel);
    }

    // Idle with completed step -> green solid dot, "Idle" / "جاهز"
    const idleState = deriveComputerState({
      turns: [makeTurn('t-idle', [makeToolCall({ id: 'i1', name: 'bash', kind: 'shell', input: { command: 'pwd' } })], false)],
      isBusy: false,
    });
    const idleView = deriveComputerDockView(idleState, 'en');
    expect(idleView.dotColor).toBe('green');
    expect(idleView.dotAnimated).toBe(false);
    expect(idleView.label).toBe('Idle');
    expect(deriveComputerDockView(idleState, 'ar').label).toBe('جاهز');

    // Network restricted (Daytona Tier 1/2 egress block) -> amber dot
    expect(detectNetworkRestriction('ERR_QUIC_PROTOCOL_ERROR on https://www.google.com')).toBe(true);
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
                content: [{ type: 'text', text: 'net::ERR_CONNECTION_RESET (Internet is restricted on Tier 1 and Tier 2)' }],
                is_error: true,
              },
            }),
          ],
          false,
        ),
      ],
      isBusy: false,
    });
    expect(restrictedState.status).toBe('network_restricted');
    const restrictedView = deriveComputerDockView(restrictedState, 'en');
    expect(restrictedView.dotColor).toBe('amber');
    expect(restrictedView.label).toBe('Network restricted');
    expect(deriveComputerDockView(restrictedState, 'ar').label).toBe('الشبكة مقيدة');

    // Waking -> amber, Stopped -> grey, Error -> red
    const wakingView = deriveComputerDockView(
      deriveComputerState({ turns: [], isBusy: false, reachability: { checked: true, reachable: false, connection: 'waking' } }),
      'en',
    );
    expect(wakingView.dotColor).toBe('amber');
    expect(wakingView.label).toBe('Waking computer');

    const stoppedView = deriveComputerDockView(
      deriveComputerState({ turns: [], isBusy: false, sandboxStatus: 'stopped' }),
      'en',
    );
    expect(stoppedView.dotColor).toBe('grey');
    expect(stoppedView.label).toBe('Inactive');

    const errorView = deriveComputerDockView(
      deriveComputerState({ turns: [], isBusy: false, connectError: { code: 'DAYTONA_ORG_SUSPENDED' } }),
      'en',
    );
    expect(errorView.dotColor).toBe('red');
    expect(errorView.label).toContain('Daytona');
  });

  test('bounds memory on pathological 50,000-line output and >120 steps', () => {
    const hugeOutput = Array.from({ length: 50_000 }, (_, i) => `line ${i}: some verbose build log output`).join('\n');
    const truncated = truncateStepText(hugeOutput);

    expect(truncated.truncated).toBe(true);
    expect(truncated.text.length).toBeLessThanOrEqual(MAX_STEP_OUTPUT_CHARS);
    expect(truncated.lineCount).toBeLessThanOrEqual(MAX_STEP_LINES);
    expect(truncated.omittedChars).toBeGreaterThan(100_000);

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

    expect(state.status).toBe('idle');
    expect(state.steps).toHaveLength(MAX_COMPUTER_STEPS);
    expect(state.droppedStepsCount).toBe(35);
    expect(state.steps[0].id).toBe('step-35');
    expect(state.activeStep?.id).toBe('step-154');
  });

  test('enforces state precedence: offline -> typed DAYTONA_* error -> waking -> stopped -> empty -> idle', () => {
    expect(
      deriveComputerState({
        turns: [],
        isBusy: true,
        isOffline: true,
      }).status,
    ).toBe('offline');

    const suspended = deriveComputerState({
      turns: [],
      isBusy: false,
      connectError: { code: 'DAYTONA_ORG_SUSPENDED' },
      locale: 'ar',
    });
    expect(suspended.status).toBe('error');
    expect(suspended.error?.action).toBe('billing');
    expect(suspended.error?.title).toContain('Daytona');

    const reconnect = deriveComputerState({
      turns: [],
      isBusy: false,
      connectError: { code: 'DAYTONA_RECONNECT_REQUIRED' },
    });
    expect(reconnect.status).toBe('error');
    expect(reconnect.error?.action).toBe('reconnect');

    const waking = deriveComputerState({
      turns: [],
      isBusy: false,
      reachability: { checked: true, reachable: false, connection: 'waking' },
    });
    expect(waking.status).toBe('waking');

    const stopped = deriveComputerState({
      turns: [],
      isBusy: false,
      sandboxStatus: 'stopped',
    });
    expect(stopped.status).toBe('stopped');

    const empty = deriveComputerState({
      turns: [],
      isBusy: false,
    });
    expect(empty.status).toBe('empty');
  });

  test('timeline scrubber resolves live vs historical steps and bilingual RTL copy', () => {
    const state = deriveComputerState({
      turns: [
        makeTurn('t1', [
          makeToolCall({ id: 's1', name: 'bash', input: { command: 'pwd' } }),
          makeToolCall({ id: 's2', name: 'bash', input: { command: 'ls' } }),
          makeToolCall({ id: 's3', name: 'bash', input: { command: 'whoami' } }),
        ]),
      ],
      isBusy: false,
    });

    expect(resolveComputerStepIndex(state.steps, null)).toEqual({
      index: 2,
      isLive: true,
      step: state.steps[2],
    });
    expect(resolveComputerStepIndex(state.steps, 's1')).toEqual({
      index: 0,
      isLive: false,
      step: state.steps[0],
    });
    expect(resolveComputerStepIndex(state.steps, 's3').isLive).toBe(true);

    expect(deriveDesktopProxyUrl('https://kortix.example/v1/p/abc-def/8000/')).toBe(
      'https://kortix.example/v1/p/abc-def/6901/',
    );
    expect(deriveDesktopProxyUrl('https://kortix.example/other')).toBeNull();

    expect(getComputerCopy('en').isRtl).toBe(false);
    expect(getComputerCopy('ar-IQ').isRtl).toBe(true);
  });
});
