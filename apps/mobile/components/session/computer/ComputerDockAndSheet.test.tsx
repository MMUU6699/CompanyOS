import React, { forwardRef, useImperativeHandle } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import TestRenderer, { act } from 'react-test-renderer';
import type { SessionLogTurn, ToolCallBlock } from '@kortix/sdk';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let presentCalls = 0;
let dismissCalls = 0;

mock.module('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Platform: { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default },
  Linking: { openURL: mock(async () => true) },
  AppState: {
    currentState: 'active',
    addEventListener: mock(() => ({ remove: () => {} })),
  },
  BackHandler: {
    addEventListener: mock(() => ({ remove: () => {} })),
  },
}));

mock.module('react-native-webview', () => ({
  WebView: 'WebView',
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

mock.module('@/api/config', () => ({
  API_URL: 'https://api.example.com/v1',
}));

mock.module('@/lib/utils/html-embed', () => ({
  isTrustedProxyUrl: (url: string) => url.startsWith('https://api.example.com/v1/p/'),
  allowBrowserNavigation: () => true,
}));

mock.module('@/components/session/computer/useDesktopThumbnail', () => ({
  useDesktopThumbnail: () => null,
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
      foreground: 'hsl(0 0% 12.2%)',
      card: 'hsl(0 0% 95.7%)',
      border: 'hsl(0 0% 88.6%)',
      mutedForeground: 'hsl(0 0% 40%)',
    },
    dark: {
      background: 'hsl(0 0% 4.3%)',
      foreground: 'hsl(0 0% 100%)',
      card: 'hsl(0 0% 7.8%)',
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

mock.module('@/components/ui/text', () => ({ Text: 'Text' }));
mock.module('@/components/ui/icon', () => ({ Icon: 'Icon' }));
mock.module('@/components/ui/button', () => ({ Button: 'Pressable' }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: 'Loader' }));
mock.module('@/components/session/dot-matrix/session-dot-matrix', () => ({ SessionDotMatrix: 'DotMatrix' }));
mock.module('@/components/session/tool/shared/styles', () => ({ monoFont: 'monospace' }));
mock.module('@/components/session/tool/shared/navigation', () => ({
  useToolFilePreviewStore: (sel: (s: { openPreview: () => void }) => unknown) =>
    sel({ openPreview: () => {} }),
}));
mock.module('@/stores/tool-preview-store', () => ({
  useToolPreviewStore: (sel: (s: { openPreview: () => void }) => unknown) =>
    sel({ openPreview: () => {} }),
}));
mock.module('@/stores/tab-store', () => ({
  useTabStore: { subscribe: () => () => {} },
}));

mock.module('@/lib/icons', () => {
  const stub = () => null;
  return {
    ArrowCounterClockwiseIcon: stub,
    ArrowSquareOutIcon: stub,
    CaretDownIcon: stub,
    CaretLeftIcon: stub,
    CaretRightIcon: stub,
    CaretUpIcon: stub,
    CpuIcon: stub,
    FileCodeIcon: stub,
    GlobeIcon: stub,
    LockIcon: stub,
    LockOpenIcon: stub,
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
      React.createElement('Text', { testID: 'computer-sheet-title' }, title),
      React.createElement('Pressable', { testID: 'computer-sheet-close', onPress: onClose }),
    ),
}));

const { ComputerDock, ComputerDockShell } = await import('./ComputerDock');
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
      command: 'DISPLAY=:1 AGENT_BROWSER_HEADED=true agent-browser open https://github.com/Simpleyyt/ai-manus',
    },
    status: 'complete',
    result: {
      content: [{ type: 'text', text: 'RAW_ACCESSIBILITY_TREE_DUMP_LINE_1\nlink "Code" [ref=e1]' }],
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

describe('ComputerDock + ComputerSheet live desktop & steps modes', () => {
  beforeEach(() => {
    presentCalls = 0;
    dismissCalls = 0;
    useComputerSheetStore.setState({ openSessionId: null, initialTab: 'steps' });
  });

  test('dock opens sheet in Live view, switches to Steps (no bash header, collapsed Details, no Open preview for external URL), and closes cleanly', () => {
    const turns = makeBrowserTurn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(
            ComputerDockShell,
            { active: true },
            React.createElement(ComputerDock, {
              sessionId: 'sess-1',
              turns,
              isBusy: true,
              sandboxUrl: 'https://api.example.com/v1/p/ext-1/8000',
            }),
          ),
          React.createElement(ComputerSheet, {
            sessionId: 'sess-1',
            turns,
            isBusy: true,
            sandboxUrl: 'https://api.example.com/v1/p/ext-1/8000',
            agentName: 'My Kortix',
          }),
        ),
      );
    });

    // 1. Before tap: sheet unmounted, dismiss() never called, dock shows humanized domain (no raw env vars).
    expect(presentCalls).toBe(0);
    expect(dismissCalls).toBe(0);
    expect(renderer.root.findAllByProps({ testID: 'session-computer-sheet' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'session-computer-shell' })).toHaveLength(1);
    expect(renderer.root.findByProps({ testID: 'computer-dock-label' }).props.children).toBe('Using Browser');
    expect(renderer.root.findByProps({ testID: 'computer-dock-detail' }).props.children).toBe('github.com');

    // 2. Tap dock -> mounts sheet in Live view with "<agent>'s computer" title & humanized caption.
    const dockBtn = renderer.root.findByProps({ testID: 'session-computer-dock-button' });
    act(() => {
      dockBtn.props.onPress();
    });

    expect(presentCalls).toBe(1);
    expect(dismissCalls).toBe(0);
    expect(renderer.root.findAllByProps({ testID: 'session-computer-sheet' })).toHaveLength(1);
    expect(renderer.root.findByProps({ testID: 'computer-sheet-title' }).props.children).toBe("My Kortix's computer");
    expect(renderer.root.findByProps({ testID: 'computer-sheet-caption' }).props.children).toBe(
      'My Kortix is using Browser · github.com',
    );
    expect(renderer.root.findAllByProps({ testID: 'computer-live-desktop' })).toHaveLength(1);

    // 3. Switch mode -> Steps: Browser header (not "bash"), no "Open preview" for github.com, raw output collapsed behind Details.
    const stepsTab = renderer.root.findByProps({ testID: 'computer-sheet-mode-steps' });
    act(() => {
      stepsTab.props.onPress();
    });

    expect(renderer.root.findAllByProps({ testID: 'computer-steps-pane' })).toHaveLength(1);
    expect(renderer.root.findByProps({ testID: 'computer-step-header-title' }).props.children).toBe('Browser');
    expect(renderer.root.findAllByProps({ testID: 'computer-open-preview-btn' })).toHaveLength(0);
    expect(collectText(renderer.toJSON())).not.toContain('RAW_ACCESSIBILITY_TREE_DUMP_LINE_1');

    // Expand Details -> reveals raw output cleanly
    const detailsToggle = renderer.root.findByProps({ testID: 'computer-details-toggle' });
    act(() => {
      detailsToggle.props.onPress();
    });
    expect(collectText(renderer.toJSON())).toContain('RAW_ACCESSIBILITY_TREE_DUMP_LINE_1');

    // 4. Close sheet -> unmounts cleanly.
    const closeBtn = renderer.root.findByProps({ testID: 'computer-sheet-close' });
    act(() => {
      closeBtn.props.onPress();
    });
    expect(dismissCalls).toBe(1);
    expect(renderer.root.findAllByProps({ testID: 'session-computer-sheet' })).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});
