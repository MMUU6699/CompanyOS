import { describe, expect, test } from 'bun:test';
import type { SessionLogTurn, ToolCallBlock } from '@kortix/sdk';
import {
  MAX_COMPUTER_STEPS,
  MAX_STEP_LINES,
  MAX_STEP_OUTPUT_CHARS,
  classifyComputerTool,
  deriveComputerState,
  deriveDesktopProxyUrl,
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
  test('classifies terminal, browser, files, and mcp tool families accurately', () => {
    expect(classifyComputerTool('bash', { command: 'ls -la' }, 'shell')).toBe('terminal');
    expect(classifyComputerTool('pty_spawn', { command: 'htop' })).toBe('terminal');
    expect(classifyComputerTool('agent_browser', { url: 'https://example.com' })).toBe('browser');
    expect(classifyComputerTool('scrape_webpage', { url: 'https://kortix.com' })).toBe('browser');
    expect(classifyComputerTool('show', { url: 'http://localhost:8080/' })).toBe('browser');
    expect(classifyComputerTool('edit', { filePath: '/workspace/app.ts' }, 'edit')).toBe('files');
    expect(classifyComputerTool('grep', { pattern: 'TODO' }, 'grep')).toBe('files');
    expect(classifyComputerTool('web_search', { query: 'daytona docs' }, 'web_search')).toBe('mcp');
    expect(classifyComputerTool('mcp__github__list_issues', { owner: 'kortix' }, 'mcp')).toBe('mcp');
  });

  test('extracts terminal, browser, file diff, and MCP steps while hiding internal todo/question calls', () => {
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
            name: 'agent_browser',
            input: { url: 'https://www.google.com/search?q=kortix', action: 'navigate' },
            result: {
              content: [{ type: 'text', text: 'Navigated to Google' }],
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
    expect(state.steps[0].exitCode).toBe(0);

    expect(state.steps[1].surface).toBe('browser');
    expect(state.steps[1].subtitle).toBe('www.google.com/search');

    expect(state.steps[2].surface).toBe('files');
    expect(state.steps[2].diffStats).toEqual({ additions: 2, deletions: 1 });

    expect(state.steps[3].surface).toBe('mcp');
    expect(state.steps[3].serverName).toBe('supabase');
    expect(state.steps[3].status).toBe('running');
    expect(state.activeSurface).toBe('mcp');
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
