import React, { forwardRef, useImperativeHandle } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import TestRenderer, { act } from 'react-test-renderer';
import type { SessionLogTurn, ToolCallBlock } from '@kortix/sdk';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Native / UI mocks for Bun component test ────────────────────────────────

let presentCalls = 0;
let dismissCalls = 0;
let lastOnDismiss: (() => void) | undefined;

mock.module('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Platform: { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default },
  Linking: { openURL: mock(async () => true) },
  BackHandler: {
    addEventListener: mock(() => ({ remove: () => {} })),
  },
}));

mock.module('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  Easing: { inOut: () => ({}), ease: {} },
  useSharedValue: (v: number) => ({ value: v }),
  useAnimatedStyle: (fn: () => Record<string, unknown>) => fn(),
  withRepeat: (v: number) => v,
  withSequence: (...vals: number[]) => vals[vals.length - 1] ?? 1,
  withTiming: (v: number) => v,
}));

mock.module('nativewind', () => ({
  useColorScheme: () => ({ colorScheme: 'dark' }),
}));

mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

mock.module('@/contexts', () => ({
  useLanguage: () => ({
    currentLanguage: 'en',
    t: (key: string, opts?: Record<string, string>) => {
      const map: Record<string, string> = {
        'computer.usingBrowser': 'Using Browser',
        'computer.usingTerminal': 'Using Terminal',
        'computer.idle': 'Idle',
      };
      if (key === 'computer.usingConnector' && opts?.name) return `Using ${opts.name}`;
      return map[key] ?? key;
    },
  }),
}));

mock.module('@/hooks/useSandboxReachability', () => ({
  useSandboxReachability: () => ({ checked: true, reachable: true, connection: 'connected' }),
}));

mock.module('@/lib/network/use-online-status', () => ({
  useOnlineStatus: () => true,
}));

mock.module('@/lib/haptics', () => ({
  haptics: { tap: () => {} },
}));

mock.module('@/lib/utils/theme', () => ({
  THEME: {
    light: {
      background: 'hsl(0 0% 100%)',
      border: 'hsl(0 0% 88.6%)',
      mutedForeground: 'hsl(0 0% 40%)',
    },
    dark: {
      background: 'hsl(0 0% 4.3%)',
      border: 'hsl(0 0% 14.9%)',
      mutedForeground: 'hsl(0 0% 60%)',
    },
    accent: {
      blue: 'hsl(210 93% 56.9%)',
      yellow: 'hsl(48 100% 40%)',
      orange: 'hsl(37.1 78.7% 45.9%)',
      green: 'hsl(135 70.5% 33.8%)',
      purple: 'hsl(270 51.3% 67.1%)',
      red: 'hsl(360 85.3% 62%)',
    },
  },
}));

mock.module('@/lib/onboarding/daytona-client', () => ({
  notifyDaytonaReconnectRequired: () => {},
}));

mock.module('@/components/ui/text', () => ({
  Text: 'Text',
}));

mock.module('@/components/ui/icon', () => ({
  Icon: 'Icon',
}));

mock.module('@/components/ui/button', () => ({
  Button: 'Pressable',
}));

mock.module('@/components/kortix/kortix-loader', () => ({
  KortixLoader: () => React.createElement('Loader'),
}));

mock.module('@/components/session/dot-matrix/session-dot-matrix', () => ({
  SessionDotMatrix: () => React.createElement('DotMatrix'),
}));

mock.module('@/components/session/tool/shared/styles', () => ({
  monoFont: 'monospace',
}));

mock.module('@/components/session/tool/shared/navigation', () => ({
  useToolFilePreviewStore: (sel: (s: { openPreview: () => void }) => unknown) =>
    sel({ openPreview: () => {} }),
}));

mock.module('@/stores/tool-preview-store', () => ({
  useToolPreviewStore: (sel: (s: { openPreview: () => void }) => unknown) =>
    sel({ openPreview: () => {} }),
}));

mock.module('@/stores/tab-store', () => ({
  useTabStore: {
    subscribe: () => () => {},
  },
}));

mock.module('@/lib/icons', () => {
  const stub = () => null;
  return {
    ArrowSquareOutIcon: stub,
    CaretLeftIcon: stub,
    CaretRightIcon: stub,
    CaretUpIcon: stub,
    CpuIcon: stub,
    FileCodeIcon: stub,
    GlobeIcon: stub,
    MonitorIcon: stub,
    TerminalWindowIcon: stub,
    WarningCircleIcon: stub,
    WifiSlashIcon: stub,
  };
});

mock.module('@/components/kortix/sheet-parts', () => ({
  SheetScrollView: forwardRef((props: Record<string, unknown>, _ref) =>
    React.createElement('ScrollView', props, props.children as React.ReactNode),
  ),
}));

mock.module('@/components/kortix/sheet', () => ({
  KortixBottomSheetModal: forwardRef(
    (
      props: { children?: React.ReactNode; onDismiss?: () => void },
      ref: React.ForwardedRef<{ present: () => void; dismiss: () => void }>,
    ) => {
      lastOnDismiss = props.onDismiss;
      useImperativeHandle(ref, () => ({
        present: () => {
          presentCalls += 1;
        },
        dismiss: () => {
          dismissCalls += 1;
          props.onDismiss?.();
        },
      }));
      return React.createElement('BottomSheetModal', props, props.children);
    },
  ),
  SheetTitleRow: ({ title, onClose }: { title: string; onClose?: () => void }) =>
    React.createElement(
      'View',
      { testID: 'sheet-title-row' },
      React.createElement('Text', {}, title),
      React.createElement('Pressable', { testID: 'computer-sheet-close', onPress: onClose }),
    ),
}));

// Load components AFTER mocks are registered.
const { ComputerDock } = await import('./ComputerDock');
const { ComputerSheet } = await import('./ComputerSheet');
const { useComputerSheetStore } = await import('@/stores/computer-sheet-store');

function makeBrowserTurn(): SessionLogTurn[] {
  const call: ToolCallBlock = {
    type: 'tool_call',
    id: 'step-browser-1',
    call_id: 'call_browser_1',
    name: 'bash',
    kind: 'shell',
    input: {
      command: 'AGENT_BROWSER_HEADED=false agent-browser open https://www.google.com && agent-browser get title',
    },
    status: 'complete',
    result: {
      content: [{ type: 'text', text: 'Title: Google' }],
      is_error: false,
    },
  };
  return [{ id: 'turn-1', live: true, blocks: [call] } as unknown as SessionLogTurn];
}

function collectText(node: TestRenderer.ReactTestRendererJSON | TestRenderer.ReactTestRendererJSON[] | string | null): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  return (node.children ?? []).map((c) => collectText(c as TestRenderer.ReactTestRendererJSON)).join(' ');
}

describe('ComputerDock + ComputerSheet interaction', () => {
  beforeEach(() => {
    presentCalls = 0;
    dismissCalls = 0;
    lastOnDismiss = undefined;
    useComputerSheetStore.setState({ openSessionId: null, initialTab: 'steps' });
  });

  test('pressing dock opens sheet (never calling dismiss before present), renders real tool content, and closing hides it', () => {
    const turns = makeBrowserTurn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(ComputerDock, {
            sessionId: 'sess-1',
            turns,
            isBusy: true,
            sandboxUrl: 'https://api.example.com/v1/p/ext-1/8000',
          }),
          React.createElement(ComputerSheet, {
            sessionId: 'sess-1',
            turns,
            isBusy: true,
            sandboxUrl: 'https://api.example.com/v1/p/ext-1/8000',
          }),
        ),
      );
    });

    // 1. Before tap: sheet is NOT mounted, dismiss() was NEVER called on initial mount.
    expect(presentCalls).toBe(0);
    expect(dismissCalls).toBe(0);
    expect(renderer.root.findAllByProps({ testID: 'session-computer-sheet' })).toHaveLength(0);

    // Dock renders thumbnail + animated blue dot + pure label "Using Browser".
    expect(renderer.root.findAllByProps({ testID: 'computer-dock-thumb-browser' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ testID: 'computer-dock-dot-blue' })).toHaveLength(1);
    const labelNode = renderer.root.findByProps({ testID: 'computer-dock-label' });
    expect(labelNode.props.children).toBe('Using Browser');

    // 2. Press dock -> sheet mounts, calls present() once, displays real browser step content.
    const dockBtn = renderer.root.findByProps({ testID: 'session-computer-dock-button' });
    act(() => {
      dockBtn.props.onPress();
    });

    expect(presentCalls).toBe(1);
    expect(dismissCalls).toBe(0);
    expect(renderer.root.findAllByProps({ testID: 'session-computer-sheet' })).toHaveLength(1);
    const fullText = collectText(renderer.toJSON());
    expect(fullText).toContain('https://www.google.com');
    expect(fullText).toContain('Google');

    // 3. Close sheet -> dismisses and unmounts cleanly.
    const closeBtn = renderer.root.findByProps({ testID: 'computer-sheet-close' });
    act(() => {
      closeBtn.props.onPress();
    });

    expect(dismissCalls).toBe(1);
    expect(renderer.root.findAllByProps({ testID: 'session-computer-sheet' })).toHaveLength(0);
    expect(lastOnDismiss).toBeDefined();

    // 4. Press dock a second time -> reopens reliably.
    act(() => {
      dockBtn.props.onPress();
    });
    expect(presentCalls).toBe(2);
    expect(renderer.root.findAllByProps({ testID: 'session-computer-sheet' })).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });
});
