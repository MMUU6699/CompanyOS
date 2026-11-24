/**
 * ComputerSheet — full-height Kortix bottom sheet showing the session
 * computer's live Activity steps (Terminal / Browser / Files / Search & MCP),
 * interactive `/kortix/pty` Terminal, and `:6901` voxl Desktop stream with
 * explicit Take control / Return control shielding.
 *
 * Uses Kortix design tokens, `KortixBottomSheetModal`, and `sheet-parts`
 * exclusively. Never embeds auth tokens in URLs for WebViews (`authenticatedRequest`
 * headers gated by `isTrustedProxyUrl`).
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Pressable,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  authenticatedRequest,
  classifyPtyClose,
  createKortixPty,
  getKortixPtyWebSocketUrl,
  listKortixPty,
  type SessionLogTurn,
} from '@kortix/sdk';
import { API_URL } from '@/api/config';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { SheetRawTextInput, SheetScrollView } from '@/components/kortix/sheet-parts';
import { SessionDotMatrix } from '@/components/session/dot-matrix/session-dot-matrix';
import { useToolFilePreviewStore } from '@/components/session/tool/shared/navigation';
import { monoFont } from '@/components/session/tool/shared/styles';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import { useSandboxReachability } from '@/hooks/useSandboxReachability';
import { haptics } from '@/lib/haptics';
import { useOnlineStatus } from '@/lib/network/use-online-status';
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CpuIcon,
  FileCodeIcon,
  GlobeIcon,
  LockIcon,
  LockOpenIcon,
  MonitorIcon,
  PaperPlaneTiltIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WifiSlashIcon,
  type AppIcon,
} from '@/lib/icons';
import { notifyDaytonaReconnectRequired } from '@/lib/onboarding/daytona-client';
import { isScrollPinnedToEnd } from '@/lib/session/activity';
import {
  deriveComputerState,
  getComputerCopy,
  resolveComputerStepIndex,
  truncateStepText,
  type ComputerCopy,
  type ComputerStep,
  type ComputerSurface,
} from '@/lib/session/computer-steps';
import { allowBrowserNavigation, isTrustedProxyUrl } from '@/lib/utils/html-embed';
import { THEME } from '@/lib/utils/theme';
import { useComputerSheetStore, type ComputerSheetTab } from '@/stores/computer-sheet-store';
import { useToolPreviewStore } from '@/stores/tool-preview-store';

const DAYTONA_BILLING_URL = 'https://app.daytona.io/dashboard/billing';
const SNAP_POINTS = ['92%'];
const MAX_PTY_BUFFER_CHARS = 24_000;

const SURFACE_ICONS: Record<ComputerSurface, AppIcon> = {
  terminal: TerminalWindowIcon,
  browser: GlobeIcon,
  files: FileCodeIcon,
  mcp: CpuIcon,
};

export interface ComputerSheetProps {
  sessionId: string;
  turns: ReadonlyArray<SessionLogTurn>;
  isBusy: boolean;
  sandboxUrl?: string;
}

function ComputerSheetImpl({ sessionId, turns, isBusy, sandboxUrl }: ComputerSheetProps) {
  const modalRef = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const pageBackground = isDark ? THEME.dark.background : THEME.light.background;

  const openSessionId = useComputerSheetStore((s) => s.openSessionId);
  const initialTab = useComputerSheetStore((s) => s.initialTab);
  const closeComputer = useComputerSheetStore((s) => s.closeComputer);
  const isOpen = openSessionId === sessionId;

  const [activeTab, setActiveTab] = useState<ComputerSheetTab>('steps');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      modalRef.current?.present();
    } else {
      modalRef.current?.dismiss();
    }
  }, [isOpen, initialTab]);

  const { currentLanguage } = useLanguage();
  const copy = useMemo(() => getComputerCopy(currentLanguage), [currentLanguage]);
  const isOnline = useOnlineStatus();
  const isOffline = !isOnline;
  const reachability = useSandboxReachability(sandboxUrl);

  const state = useMemo(
    () =>
      deriveComputerState({
        turns,
        isBusy,
        isOffline,
        sandboxUrl,
        reachability,
        locale: currentLanguage,
      }),
    [turns, isBusy, isOffline, sandboxUrl, reachability, currentLanguage],
  );

  const resolved = useMemo(
    () => resolveComputerStepIndex(state.steps, selectedStepId),
    [state.steps, selectedStepId],
  );

  const handleStepPrev = useCallback(() => {
    if (resolved.index <= 0) return;
    haptics.tap();
    const target = state.steps[resolved.index - 1];
    if (target) setSelectedStepId(target.id);
  }, [resolved.index, state.steps]);

  const handleStepNext = useCallback(() => {
    if (resolved.index < 0 || resolved.index >= state.steps.length - 1) return;
    haptics.tap();
    const nextIdx = resolved.index + 1;
    if (nextIdx >= state.steps.length - 1) {
      setSelectedStepId(null);
    } else {
      setSelectedStepId(state.steps[nextIdx]?.id ?? null);
    }
  }, [resolved.index, state.steps]);

  const handleJumpLive = useCallback(() => {
    haptics.tap();
    setSelectedStepId(null);
  }, []);

  return (
    <KortixBottomSheetModal
      ref={modalRef}
      title={copy.computerTitle}
      snapPoints={SNAP_POINTS}
      enableDynamicSizing={false}
      topInset={insets.top}
      enablePanDownToClose
      enableContentPanningGesture={false}
      backgroundStyle={{ backgroundColor: pageBackground }}
      onDismiss={closeComputer}
    >
      <View style={{ flex: 1, paddingBottom: Math.max(insets.bottom, 12) }} className="bg-background">
        {/* Kortix monochrome segmented mode tabs */}
        <View
          className={
            copy.isRtl
              ? 'flex-row-reverse items-center justify-between gap-2 px-4 pb-3'
              : 'flex-row items-center justify-between gap-2 px-4 pb-3'
          }
        >
          <View
            className={
              copy.isRtl
                ? 'flex-1 flex-row-reverse rounded-full border border-border bg-muted/40 p-1'
                : 'flex-1 flex-row rounded-full border border-border bg-muted/40 p-1'
            }
          >
            {(
              [
                { id: 'steps', label: copy.tabSteps, icon: CpuIcon },
                { id: 'terminal', label: copy.tabTerminal, icon: TerminalWindowIcon },
                { id: 'desktop', label: copy.tabDesktop, icon: MonitorIcon },
              ] as const
            ).map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <Pressable
                  key={tab.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  onPress={() => {
                    haptics.tap();
                    setActiveTab(tab.id);
                  }}
                  className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-full py-1.5 ${
                    selected ? 'border border-border bg-background' : ''
                  }`}
                >
                  <Icon
                    as={tab.icon}
                    size={14}
                    className={selected ? 'text-foreground' : 'text-muted-foreground'}
                  />
                  <Text
                    className={`text-[12px] ${
                      selected
                        ? 'font-roobert-medium text-foreground'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Body */}
        {state.status === 'offline' ? (
          <StatusNotice
            icon={WifiSlashIcon}
            title={copy.offline}
            message={copy.offlineHint}
            copy={copy}
          />
        ) : state.status === 'error' && state.error ? (
          <View className="flex-1 justify-center px-6">
            <View className="gap-3 rounded-3xl border border-border bg-card p-4">
              <View className="flex-row items-center gap-2">
                <Icon as={WarningCircleIcon} size={18} color={THEME.accent.orange} />
                <Text className="flex-1 text-[15px] font-roobert-medium text-foreground">
                  {state.error.title}
                </Text>
              </View>
              <Text className="text-[13px] leading-5 text-muted-foreground">
                {state.error.message}
              </Text>
              <View className="flex-row gap-2 pt-1">
                {state.error.action === 'reconnect' ? (
                  <Button
                    variant="default"
                    size="sm"
                    className="flex-1 rounded-full"
                    onPress={() => {
                      closeComputer();
                      notifyDaytonaReconnectRequired();
                    }}
                  >
                    <Text>{copy.reconnectDaytona}</Text>
                  </Button>
                ) : state.error.action === 'billing' ? (
                  <Button
                    variant="default"
                    size="sm"
                    className="flex-1 rounded-full"
                    onPress={() => void Linking.openURL(DAYTONA_BILLING_URL)}
                  >
                    <Text>{copy.openDaytonaBilling}</Text>
                  </Button>
                ) : null}
              </View>
            </View>
          </View>
        ) : activeTab === 'desktop' ? (
          <LiveDesktopPane
            desktopProxyUrl={state.desktopProxyUrl}
            pageBackground={pageBackground}
            copy={copy}
          />
        ) : activeTab === 'terminal' ? (
          <LivePtyPane sandboxUrl={sandboxUrl} copy={copy} />
        ) : (
          <StepsInspectorPane
            sessionId={sessionId}
            state={state}
            resolved={resolved}
            copy={copy}
            onPrev={handleStepPrev}
            onNext={handleStepNext}
            onJumpLive={handleJumpLive}
            onSwitchDesktop={() => setActiveTab('desktop')}
          />
        )}
      </View>
    </KortixBottomSheetModal>
  );
}

// ─── Steps Inspector + Scrubber ──────────────────────────────────────────────

function StepsInspectorPane({
  sessionId,
  state,
  resolved,
  copy,
  onPrev,
  onNext,
  onJumpLive,
  onSwitchDesktop,
}: {
  sessionId: string;
  state: ReturnType<typeof deriveComputerState>;
  resolved: ReturnType<typeof resolveComputerStepIndex>;
  copy: ComputerCopy;
  onPrev: () => void;
  onNext: () => void;
  onJumpLive: () => void;
  onSwitchDesktop: () => void;
}) {
  const scrollRef = useRef<any>(null);
  const pinnedRef = useRef(true);
  const openPreview = useToolPreviewStore((s) => s.openPreview);
  const openFilePreview = useToolFilePreviewStore((s) => s.openPreview);

  const step = resolved.step;

  // Auto-scroll terminal/step output while live & pinned to end; pause when user scrolls up.
  useEffect(() => {
    if (resolved.isLive && pinnedRef.current && step?.output.text) {
      scrollRef.current?.scrollToEnd?.({ animated: false });
    }
  }, [resolved.isLive, step?.id, step?.output.text]);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    pinnedRef.current = isScrollPinnedToEnd(
      contentOffset.y,
      contentSize.height,
      layoutMeasurement.height,
    );
  }, []);

  if (!step) {
    if (state.status === 'waking') {
      return (
        <StatusNotice
          icon={MonitorIcon}
          title={copy.waking}
          message={copy.wakingHint}
          loading
          copy={copy}
        />
      );
    }
    if (state.status === 'stopped') {
      return (
        <StatusNotice
          icon={MonitorIcon}
          title={copy.stopped}
          message={copy.stoppedHint}
          copy={copy}
        />
      );
    }
    return (
      <StatusNotice
        icon={MonitorIcon}
        title={copy.emptyTitle}
        message={copy.emptyHint}
        copy={copy}
      />
    );
  }

  const SurfaceIcon = SURFACE_ICONS[step.surface];
  const total = state.steps.length;
  const progressPct = total <= 1 ? 100 : Math.round(((resolved.index + 1) / total) * 100);

  return (
    <View style={{ flex: 1 }} className="px-4">
      {/* Step viewport card */}
      <View style={{ flex: 1 }} className="overflow-hidden rounded-3xl border border-border bg-card">
        {/* Card header */}
        <View
          className={
            copy.isRtl
              ? 'flex-row-reverse items-center justify-between gap-2 border-b border-border px-3.5 py-2.5'
              : 'flex-row items-center justify-between gap-2 border-b border-border px-3.5 py-2.5'
          }
        >
          <View
            className={
              copy.isRtl
                ? 'min-w-0 flex-1 flex-row-reverse items-center gap-2'
                : 'min-w-0 flex-1 flex-row items-center gap-2'
            }
          >
            {step.status === 'running' ? (
              <SessionDotMatrix sessionId={sessionId} size={13} />
            ) : (
              <Icon as={SurfaceIcon} size={15} className="text-muted-foreground" />
            )}
            <Text className="shrink text-[13px] font-roobert-medium text-foreground" numberOfLines={1}>
              {step.title}
            </Text>
            <Text variant="muted" className="flex-1 text-[12px]" numberOfLines={1}>
              {step.subtitle}
            </Text>
          </View>

          {step.surface === 'browser' && step.url ? (
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full"
              onPress={() => openPreview(step.url!, step.subtitle)}
            >
              <Icon as={ArrowSquareOutIcon} size={13} />
              <Text className="text-[12px]">{copy.openPreview}</Text>
            </Button>
          ) : step.surface === 'browser' && state.desktopProxyUrl ? (
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full"
              onPress={onSwitchDesktop}
            >
              <Icon as={LockOpenIcon} size={13} />
              <Text className="text-[12px]">{copy.takeControl}</Text>
            </Button>
          ) : step.surface === 'files' && step.diffStats ? (
            <View className="flex-row items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5">
              <Text className="text-[11px] tabular-nums text-foreground">
                {`+${step.diffStats.additions}`}
              </Text>
              <Text className="text-[11px] tabular-nums text-muted-foreground">
                {`-${step.diffStats.deletions}`}
              </Text>
            </View>
          ) : typeof step.exitCode === 'number' ? (
            <View className="rounded-full border border-border bg-muted/40 px-2 py-0.5">
              <Text className="text-[11px] tabular-nums text-muted-foreground">
                {`exit ${step.exitCode}`}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Scrollable step content */}
        <SheetScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 14, gap: 10 }}
          onScroll={handleScroll}
        >
          {step.command ? (
            <View className="rounded-2xl border border-border bg-muted/40 px-3 py-2">
              <Text style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 18 }} className="text-foreground">
                {`$ ${step.command}`}
              </Text>
            </View>
          ) : null}

          {step.url ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => openPreview(step.url!, step.subtitle)}
              className="flex-row items-center gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-2 active:opacity-75"
            >
              <Icon as={GlobeIcon} size={14} className="text-muted-foreground" />
              <Text className="flex-1 text-[12px] text-foreground" numberOfLines={1}>
                {step.url}
              </Text>
              <Icon as={ArrowSquareOutIcon} size={13} className="text-muted-foreground" />
            </Pressable>
          ) : null}

          {step.filePath ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => openFilePreview(step.filePath!)}
              className="flex-row items-center gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-2 active:opacity-75"
            >
              <Icon as={FileCodeIcon} size={14} className="text-muted-foreground" />
              <Text className="flex-1 text-[12px] text-foreground" numberOfLines={1}>
                {step.filePath}
              </Text>
              <Icon as={ArrowSquareOutIcon} size={13} className="text-muted-foreground" />
            </Pressable>
          ) : null}

          {step.argsPreview ? (
            <View className="rounded-2xl border border-border bg-muted/30 p-3">
              <Text style={{ fontFamily: monoFont, fontSize: 11.5, lineHeight: 17 }} className="text-muted-foreground">
                {step.argsPreview}
              </Text>
            </View>
          ) : null}

          {step.errorText ? (
            <View className="rounded-2xl border border-destructive/30 bg-destructive/10 p-3">
              <Text style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 18 }} className="text-destructive">
                {step.errorText}
              </Text>
            </View>
          ) : null}

          {step.output.text ? (
            <Text
              selectable
              style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 18.5 }}
              className="text-foreground"
            >
              {step.output.text}
            </Text>
          ) : step.status === 'running' ? (
            <View className="flex-row items-center gap-2 py-2">
              <SessionDotMatrix sessionId={sessionId} size={13} />
              <Text variant="muted" className="text-[13px]">
                {copy.working}
              </Text>
            </View>
          ) : null}

          {step.output.truncated ? (
            <View className="rounded-xl border border-border bg-muted/40 px-3 py-1.5">
              <Text className="text-[11px] text-muted-foreground">
                {copy.truncatedNotice(step.output.omittedChars)}
              </Text>
            </View>
          ) : null}
        </SheetScrollView>
      </View>

      {/* Timeline Scrubber Bar */}
      <View className="gap-2.5 pt-3">
        <View className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <View
            style={{ width: `${progressPct}%` }}
            className="h-full rounded-full bg-foreground"
          />
        </View>

        <View
          className={
            copy.isRtl
              ? 'flex-row-reverse items-center justify-between'
              : 'flex-row items-center justify-between'
          }
        >
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            disabled={resolved.index <= 0}
            accessibilityLabel="Previous step"
            onPress={onPrev}
          >
            <Icon as={copy.isRtl ? CaretRightIcon : CaretLeftIcon} size={18} />
          </Button>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={resolved.isLive ? copy.live : copy.stepOf(resolved.index + 1, total)}
            onPress={resolved.isLive ? undefined : onJumpLive}
            className="flex-row items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 active:opacity-75"
          >
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 3.5,
                backgroundColor: resolved.isLive ? THEME.dark.success : THEME.light.mutedForeground,
              }}
            />
            <Text className="text-[12px] font-roobert-medium tabular-nums text-foreground">
              {resolved.isLive ? copy.live : copy.stepOf(resolved.index + 1, total)}
            </Text>
          </Pressable>

          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            disabled={resolved.isLive || resolved.index >= total - 1}
            accessibilityLabel="Next step"
            onPress={onNext}
          >
            <Icon as={copy.isRtl ? CaretLeftIcon : CaretRightIcon} size={18} />
          </Button>
        </View>
      </View>
    </View>
  );
}

// ─── Live Interactive `/kortix/pty` Terminal Pane ────────────────────────────

function LivePtyPane({ sandboxUrl, copy }: { sandboxUrl?: string; copy: ComputerCopy }) {
  const [buffer, setBuffer] = useState('');
  const [command, setCommand] = useState('');
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reconnectTick, setReconnectTick] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<any>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    if (!sandboxUrl) {
      setStatus('error');
      setErrorMsg(copy.stoppedHint);
      return;
    }

    let alive = true;
    let socket: WebSocket | null = null;
    setStatus('connecting');
    setErrorMsg(null);

    const connectPty = async () => {
      try {
        const existing = await listKortixPty(sandboxUrl);
        if (!alive) return;
        const running = existing.find((p) => p.status === 'running');
        const target =
          running ??
          (await createKortixPty(sandboxUrl, {
            title: 'Mobile Computer',
          }));
        if (!alive) return;

        const wsUrl = await getKortixPtyWebSocketUrl(target.id, sandboxUrl, { wake: true });
        if (!alive) return;

        socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (alive) setStatus('ready');
        };
        socket.onmessage = (ev) => {
          if (!alive) return;
          const chunk = typeof ev.data === 'string' ? ev.data : '';
          if (!chunk) return;
          setBuffer((prev) => {
            const combined = prev + chunk;
            return combined.length > MAX_PTY_BUFFER_CHARS
              ? combined.slice(combined.length - MAX_PTY_BUFFER_CHARS)
              : combined;
          });
        };
        socket.onerror = () => {
          if (alive) setStatus('error');
        };
        socket.onclose = (ev) => {
          if (!alive) return;
          const verdict = classifyPtyClose({
            code: ev.code,
            reason: ev.reason || '',
            hadError: false,
          });
          if (verdict !== 'ended') {
            setStatus('error');
          }
        };
      } catch (err) {
        if (!alive) return;
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : 'Terminal unavailable');
      }
    };

    void connectPty();

    return () => {
      alive = false;
      wsRef.current = null;
      try {
        socket?.close();
      } catch {}
    };
  }, [sandboxUrl, reconnectTick, copy.stoppedHint]);

  const cleaned = useMemo(() => truncateStepText(buffer, 16_000, 300), [buffer]);

  useEffect(() => {
    if (pinnedRef.current && cleaned.text) {
      scrollRef.current?.scrollToEnd?.({ animated: false });
    }
  }, [cleaned.text]);

  const handleSendCommand = useCallback(() => {
    const trimmed = command.trim();
    if (!trimmed || !wsRef.current || status !== 'ready') return;
    haptics.tap();
    wsRef.current.send(`${trimmed}\n`);
    setCommand('');
  }, [command, status]);

  return (
    <View style={{ flex: 1 }} className="gap-3 px-4">
      <View style={{ flex: 1 }} className="overflow-hidden rounded-3xl border border-border bg-card">
        <View className="flex-row items-center justify-between border-b border-border px-3.5 py-2">
          <View className="flex-row items-center gap-2">
            <Icon as={TerminalWindowIcon} size={15} className="text-muted-foreground" />
            <Text className="text-[13px] font-roobert-medium text-foreground">
              {copy.tabTerminal}
            </Text>
          </View>
          {status === 'error' ? (
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full"
              onPress={() => setReconnectTick((n) => n + 1)}
            >
              <Icon as={ArrowCounterClockwiseIcon} size={13} />
              <Text className="text-[12px]">{copy.retry}</Text>
            </Button>
          ) : null}
        </View>

        {status === 'connecting' && !cleaned.text ? (
          <View className="flex-1 items-center justify-center">
            <KortixLoader size="small" />
          </View>
        ) : (
          <SheetScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 14 }}
            onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              pinnedRef.current = isScrollPinnedToEnd(
                contentOffset.y,
                contentSize.height,
                layoutMeasurement.height,
              );
            }}
          >
            <Text
              selectable
              style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 18 }}
              className="text-foreground"
            >
              {cleaned.text || (errorMsg ?? '$ ')}
            </Text>
          </SheetScrollView>
        )}
      </View>

      {/* Interactive PTY command input */}
      <View className="flex-row items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5">
        <Text style={{ fontFamily: monoFont, fontSize: 13 }} className="text-muted-foreground">
          $
        </Text>
        <SheetRawTextInput
          value={command}
          onChangeText={setCommand}
          onSubmitEditing={handleSendCommand}
          placeholder={copy.runCommandPlaceholder}
          placeholderTextColor={THEME.dark.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          editable={status === 'ready'}
          style={{
            flex: 1,
            fontFamily: monoFont,
            fontSize: 13,
            paddingVertical: 6,
            color: undefined,
          }}
          className="text-foreground"
        />
        <Button
          variant="default"
          size="sm"
          className="rounded-full"
          disabled={status !== 'ready' || !command.trim()}
          onPress={handleSendCommand}
        >
          <Icon as={PaperPlaneTiltIcon} size={13} />
          <Text className="text-[12px]">{copy.run}</Text>
        </Button>
      </View>
    </View>
  );
}

// ─── Live `:6901` voxl Desktop Pane ("Take control") ─────────────────────────

function LiveDesktopPane({
  desktopProxyUrl,
  pageBackground,
  copy,
}: {
  desktopProxyUrl: string | null;
  pageBackground: string;
  copy: ComputerCopy;
}) {
  const [inControl, setInControl] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [credential, setCredential] = useState<
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'ready'; headers: Record<string, string> }
  >({ status: 'loading' });

  const trusted = Boolean(desktopProxyUrl && isTrustedProxyUrl(desktopProxyUrl, API_URL));

  useEffect(() => {
    if (!desktopProxyUrl || !trusted) return;
    let alive = true;
    setCredential({ status: 'loading' });
    void authenticatedRequest(desktopProxyUrl).then(
      ({ headers }) => {
        if (alive) setCredential({ status: 'ready', headers });
      },
      () => {
        if (alive) setCredential({ status: 'error' });
      },
    );
    return () => {
      alive = false;
    };
  }, [desktopProxyUrl, trusted, attempt]);

  if (!desktopProxyUrl || !trusted) {
    return (
      <StatusNotice
        icon={MonitorIcon}
        title={copy.tabDesktop}
        message={copy.desktopUnavailable}
        copy={copy}
      />
    );
  }

  return (
    <View style={{ flex: 1 }} className="gap-3 px-4">
      <View
        style={{ flex: 1 }}
        className={`overflow-hidden rounded-3xl border ${
          inControl ? 'border-foreground' : 'border-border'
        } bg-card`}
      >
        <View className="flex-row items-center justify-between border-b border-border px-3.5 py-2">
          <View className="flex-row items-center gap-2">
            <Icon as={MonitorIcon} size={15} className="text-muted-foreground" />
            <Text className="text-[13px] font-roobert-medium text-foreground">
              {copy.tabDesktop}
            </Text>
          </View>

          <Button
            variant={inControl ? 'secondary' : 'default'}
            size="sm"
            className="rounded-full"
            onPress={() => {
              haptics.tap();
              setInControl((v) => !v);
            }}
          >
            <Icon as={inControl ? LockIcon : LockOpenIcon} size={13} />
            <Text className="text-[12px]">
              {inControl ? copy.returnControl : copy.takeControl}
            </Text>
          </Button>
        </View>

        <View style={{ flex: 1, position: 'relative' }}>
          {credential.status === 'loading' ? (
            <View className="flex-1 items-center justify-center bg-background">
              <KortixLoader size="small" />
            </View>
          ) : credential.status === 'error' ? (
            <View className="flex-1 items-center justify-center gap-3 px-6">
              <Text variant="muted" className="text-center text-[13px]">
                {copy.desktopUnavailable}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                className="rounded-full"
                onPress={() => setAttempt((n) => n + 1)}
              >
                <Text>{copy.retry}</Text>
              </Button>
            </View>
          ) : (
            <>
              <WebView
                source={{
                  uri: desktopProxyUrl,
                  headers: credential.headers,
                }}
                originWhitelist={['*']}
                onShouldStartLoadWithRequest={allowBrowserNavigation}
                startInLoadingState
                renderLoading={() => (
                  <View className="flex-1 items-center justify-center bg-background">
                    <KortixLoader size="small" />
                  </View>
                )}
                javaScriptEnabled
                domStorageEnabled
                style={{ flex: 1, backgroundColor: pageBackground }}
              />
              {/* Read-only shield until the user explicitly taps Take control */}
              {!inControl ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.takeControl}
                  onPress={() => {
                    haptics.tap();
                    setInControl(true);
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: 0,
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    paddingBottom: 20,
                  }}
                >
                  <View className="flex-row items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2">
                    <Icon as={LockOpenIcon} size={14} className="text-foreground" />
                    <Text className="text-[13px] font-roobert-medium text-foreground">
                      {copy.takeControl}
                    </Text>
                  </View>
                </Pressable>
              ) : null}
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function StatusNotice({
  icon,
  title,
  message,
  loading = false,
  copy,
}: {
  icon: AppIcon;
  title: string;
  message: string;
  loading?: boolean;
  copy: ComputerCopy;
}) {
  return (
    <View className="flex-1 items-center justify-center gap-2.5 px-8">
      {loading ? (
        <KortixLoader size="small" />
      ) : (
        <Icon as={icon} size={24} className="text-muted-foreground" />
      )}
      <Text
        className="text-center text-[15px] font-roobert-medium text-foreground"
        style={copy.isRtl ? { writingDirection: 'rtl' } : undefined}
      >
        {title}
      </Text>
      <Text
        variant="muted"
        className="text-center text-[13px] leading-5"
        style={copy.isRtl ? { writingDirection: 'rtl' } : undefined}
      >
        {message}
      </Text>
    </View>
  );
}

export const ComputerSheet = memo(ComputerSheetImpl);
