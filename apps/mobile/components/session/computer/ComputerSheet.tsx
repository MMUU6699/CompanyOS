/**
 * ComputerSheet — host-gated Kortix bottom sheet for the live session computer.
 *
 * - Host-gated mounting (`if (!isOpen) return null`) guarantees `BottomSheetModal`
 *   calls `present()` once on mount and never `dismiss()` before `present()`.
 * - Title: `<agent>'s computer`.
 * - Mode switcher: `Live view` (proxied voxl `:6901` desktop inside
 *   `react-native-webview` with `authenticatedRequest`, loading/502/503/reconnect,
 *   unmounted on close or background, transparent shield + Take control / Open
 *   full screen) and `Steps` (Terminal monospace scroll-pause, Browser history
 *   frame + collapsed Details, Files line diff, Tool/MCP + collapsed Details).
 * - Raw accessibility trees / verbose outputs never flood the viewport; they
 *   stay inside a collapsed `Details` disclosure.
 * - "Open preview" renders ONLY when `isLocalhostPreviewUrl(step.url)` is true.
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Image,
  Linking,
  Pressable,
  View,
  type AppStateStatus,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { authenticatedRequest, type SessionLogTurn } from '@kortix/sdk';
import { API_URL } from '@/api/config';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { KortixBottomSheetModal, SheetTitleRow } from '@/components/kortix/sheet';
import { SheetScrollView } from '@/components/kortix/sheet-parts';
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
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CpuIcon,
  FileCodeIcon,
  GlobeIcon,
  LockIcon,
  LockOpenIcon,
  MonitorIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WifiSlashIcon,
  type AppIcon,
} from '@/lib/icons';
import { notifyDaytonaReconnectRequired } from '@/lib/onboarding/daytona-client';
import { isScrollPinnedToEnd } from '@/lib/session/activity';
import {
  deriveComputerState,
  formatComputerSheetCaption,
  getComputerCopy,
  isLocalhostPreviewUrl,
  resolveComputerStepIndex,
  type ComputerCopy,
  type ComputerStep,
  type ComputerSurface,
} from '@/lib/session/computer-steps';
import { allowBrowserNavigation, isTrustedProxyUrl } from '@/lib/utils/html-embed';
import { THEME } from '@/lib/utils/theme';
import { useComputerSheetStore } from '@/stores/computer-sheet-store';
import { useTabStore } from '@/stores/tab-store';
import { useToolPreviewStore } from '@/stores/tool-preview-store';

const DAYTONA_BILLING_URL = 'https://app.daytona.io/dashboard/billing';
const SNAP_POINTS = ['92%'];

type SheetMode = 'live' | 'steps';

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
  agentName?: string;
}

function ComputerSheetHostImpl({
  sessionId,
  turns,
  isBusy,
  sandboxUrl,
  agentName,
}: ComputerSheetProps) {
  const isOpen = useComputerSheetStore((s) => s.openSessionId === sessionId);
  const initialTab = useComputerSheetStore((s) => s.initialTab);
  const closeComputer = useComputerSheetStore((s) => s.closeComputer);

  useEffect(
    () =>
      useTabStore.subscribe((state, previous) => {
        if (
          state.activeSessionId !== previous.activeSessionId ||
          state.activePageId !== previous.activePageId
        ) {
          if (useComputerSheetStore.getState().openSessionId === sessionId) {
            closeComputer();
          }
        }
      }),
    [closeComputer, sessionId],
  );

  useEffect(
    () => () => {
      if (useComputerSheetStore.getState().openSessionId === sessionId) {
        closeComputer();
      }
    },
    [closeComputer, sessionId],
  );

  if (!isOpen) return null;

  return (
    <ComputerSheetModal
      sessionId={sessionId}
      turns={turns}
      isBusy={isBusy}
      sandboxUrl={sandboxUrl}
      agentName={agentName}
      initialMode={initialTab === 'desktop' ? 'live' : 'steps'}
      onClose={closeComputer}
    />
  );
}

export const ComputerSheet = memo(ComputerSheetHostImpl);

// ─── Mounted Sheet Modal ─────────────────────────────────────────────────────

function ComputerSheetModal({
  sessionId,
  turns,
  isBusy,
  sandboxUrl,
  agentName,
  initialMode,
  onClose,
}: ComputerSheetProps & { initialMode: SheetMode; onClose: () => void }) {
  const modalRef = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const pageBackground = isDark ? THEME.dark.background : THEME.light.background;

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [mode, setMode] = useState<SheetMode>(initialMode);

  // Present once on mount (never dismiss before present).
  useEffect(() => {
    modalRef.current?.present();
  }, []);

  const handleRequestClose = useCallback(() => {
    haptics.tap();
    if (modalRef.current?.dismiss) {
      modalRef.current.dismiss();
    } else {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleRequestClose();
      return true;
    });
    return () => sub.remove();
  }, [handleRequestClose]);

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

  const canShowLiveDesktop = Boolean(state.desktopProxyUrl);
  const effectiveMode: SheetMode = mode === 'live' && canShowLiveDesktop ? 'live' : 'steps';
  const title = copy.computerTitleFor(agentName);
  const caption = formatComputerSheetCaption(agentName, resolved.step, currentLanguage);

  const handleStepPrev = useCallback(() => {
    if (resolved.index <= 0) return;
    haptics.tap();
    const target = state.steps[resolved.index - 1];
    if (target) {
      setSelectedStepId(target.id);
      setMode('steps');
    }
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
    if (state.activeSurface === 'browser' && state.desktopProxyUrl) {
      setMode('live');
    }
  }, [state.activeSurface, state.desktopProxyUrl]);

  const total = state.steps.length;
  const progressPct = total <= 1 ? 100 : Math.round(((resolved.index + 1) / total) * 100);
  const CaptionIcon = resolved.step ? SURFACE_ICONS[resolved.step.surface] : MonitorIcon;

  return (
    <KortixBottomSheetModal
      ref={modalRef}
      snapPoints={SNAP_POINTS}
      enableDynamicSizing={false}
      topInset={insets.top}
      enablePanDownToClose
      enableContentPanningGesture={false}
      backgroundStyle={{ backgroundColor: pageBackground }}
      onDismiss={onClose}
    >
      <View
        testID="session-computer-sheet"
        style={{ flex: 1, paddingBottom: Math.max(insets.bottom, 12) }}
        className="bg-background"
      >
        <SheetTitleRow title={title} onClose={handleRequestClose} />

        {/* Mode switcher (Live desktop view vs Steps inspector) */}
        {canShowLiveDesktop && state.status !== 'offline' && state.status !== 'error' ? (
          <View className="px-4 pb-2.5">
            <View
              className={
                copy.isRtl
                  ? 'flex-row-reverse rounded-full border border-border bg-muted/40 p-1'
                  : 'flex-row rounded-full border border-border bg-muted/40 p-1'
              }
            >
              {(
                [
                  { id: 'live', label: copy.modeLive, icon: MonitorIcon },
                  { id: 'steps', label: copy.modeSteps, icon: TerminalWindowIcon },
                ] as const
              ).map((tab) => {
                const selected = effectiveMode === tab.id;
                return (
                  <Pressable
                    key={tab.id}
                    testID={`computer-sheet-mode-${tab.id}`}
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      haptics.tap();
                      setMode(tab.id);
                    }}
                    className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-full py-1.5 ${
                      selected ? 'border border-border bg-background' : ''
                    }`}
                  >
                    <Icon
                      as={tab.icon}
                      size={13}
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
        ) : null}

        {/* Main Viewport (fills the sheet) */}
        <View style={{ flex: 1 }}>
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
                  <Icon as={WarningCircleIcon} size={18} color={THEME.accent.red} />
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
                        handleRequestClose();
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
          ) : effectiveMode === 'live' && state.desktopProxyUrl ? (
            <LiveDesktopViewport
              desktopProxyUrl={state.desktopProxyUrl}
              title={title}
              pageBackground={pageBackground}
              copy={copy}
              networkRestricted={state.networkRestricted}
              restrictedHost={state.restrictedHost}
            />
          ) : (
            <StepsInspectorPane
              sessionId={sessionId}
              state={state}
              resolved={resolved}
              copy={copy}
            />
          )}
        </View>

        {/* Bottom Caption + Timeline Scrubber */}
        {state.status !== 'offline' && state.status !== 'error' ? (
          <View className="gap-2.5 px-4 pt-3">
            <View
              className={
                copy.isRtl
                  ? 'flex-row-reverse items-center gap-2'
                  : 'flex-row items-center gap-2'
              }
            >
              <View className="h-6 w-6 items-center justify-center rounded-lg border border-border bg-card">
                <Icon as={CaptionIcon} size={13} className="text-muted-foreground" />
              </View>
              <Text
                testID="computer-sheet-caption"
                className="flex-1 text-[12.5px] font-roobert-medium text-foreground"
                numberOfLines={1}
                style={copy.isRtl ? { textAlign: 'right' } : undefined}
              >
                {caption}
              </Text>
            </View>

            {total > 0 ? (
              <>
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
                    onPress={handleStepPrev}
                  >
                    <Icon as={copy.isRtl ? CaretRightIcon : CaretLeftIcon} size={18} />
                  </Button>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      resolved.isLive ? copy.live : copy.stepOf(resolved.index + 1, total)
                    }
                    onPress={resolved.isLive ? undefined : handleJumpLive}
                    className="flex-row items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 active:opacity-75"
                  >
                    <View
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 3.5,
                        backgroundColor: resolved.isLive
                          ? THEME.accent.green
                          : THEME.light.mutedForeground,
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
                    onPress={handleStepNext}
                  >
                    <Icon as={copy.isRtl ? CaretLeftIcon : CaretRightIcon} size={18} />
                  </Button>
                </View>
              </>
            ) : null}
          </View>
        ) : null}
      </View>
    </KortixBottomSheetModal>
  );
}

// ─── Live Proxied Desktop WebView (voxl :6901) ───────────────────────────────

function LiveDesktopViewport({
  desktopProxyUrl,
  title,
  pageBackground,
  copy,
  networkRestricted,
  restrictedHost,
}: {
  desktopProxyUrl: string;
  title: string;
  pageBackground: string;
  copy: ComputerCopy;
  networkRestricted: boolean;
  restrictedHost: string | null;
}) {
  const openPreview = useToolPreviewStore((s) => s.openPreview);
  const trusted = isTrustedProxyUrl(desktopProxyUrl, API_URL);
  const [foreground, setForeground] = useState<boolean>(
    () => AppState.currentState === 'active',
  );
  const [credential, setCredential] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; headers: Record<string, string> }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [unreachable, setUnreachable] = useState(false);
  const [control, setControl] = useState(false);

  // Unmount WebView when app backgrounds so voxl does not stall on an un-acked viewer.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      setForeground(next === 'active');
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!trusted || !foreground) return;
    let alive = true;
    setCredential({ status: 'loading' });
    setUnreachable(false);
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
  }, [desktopProxyUrl, trusted, foreground, attempt]);

  const handleReconnect = useCallback(() => {
    haptics.tap();
    setUnreachable(false);
    setAttempt((n) => n + 1);
  }, []);

  return (
    <View testID="computer-live-desktop" style={{ flex: 1 }} className="gap-2 px-4">
      {networkRestricted ? (
        <View className="flex-row items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2">
          <Icon as={WarningCircleIcon} size={14} color={THEME.accent.orange} />
          <Text className="flex-1 text-[12px] text-foreground" numberOfLines={2}>
            {copy.networkRestrictedHost(restrictedHost)}
          </Text>
        </View>
      ) : null}

      <View
        style={{ flex: 1 }}
        className={`relative overflow-hidden rounded-3xl border bg-card ${
          control ? 'border-foreground' : 'border-border'
        }`}
      >
        {!trusted || !foreground ? (
          <View className="flex-1 items-center justify-center">
            <KortixLoader size="small" />
          </View>
        ) : credential.status === 'loading' ? (
          <View className="flex-1 items-center justify-center">
            <KortixLoader size="small" />
          </View>
        ) : credential.status === 'error' || unreachable ? (
          <View className="flex-1 items-center justify-center gap-3 px-6">
            <View className="h-11 w-11 items-center justify-center rounded-2xl border border-border bg-background">
              <Icon as={MonitorIcon} size={20} className="text-muted-foreground" />
            </View>
            <Text className="text-center text-[14px] font-roobert-medium text-foreground">
              {copy.desktopUnreachableTitle}
            </Text>
            <Text variant="muted" className="text-center text-[12.5px] leading-5">
              {copy.desktopUnreachableHint}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full"
              onPress={handleReconnect}
            >
              <Icon as={ArrowCounterClockwiseIcon} size={13} />
              <Text className="text-[12px]">{copy.reconnect}</Text>
            </Button>
          </View>
        ) : (
          <>
            <WebView
              key={`voxl-${attempt}`}
              source={{
                uri: desktopProxyUrl,
                headers: credential.headers,
              }}
              originWhitelist={['*']}
              onShouldStartLoadWithRequest={allowBrowserNavigation}
              onHttpError={(ev) => {
                if (ev.nativeEvent.statusCode >= 500) setUnreachable(true);
              }}
              onError={() => setUnreachable(true)}
              startInLoadingState
              renderLoading={() => (
                <View className="absolute inset-0 items-center justify-center bg-card">
                  <KortixLoader size="small" />
                </View>
              )}
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              style={{ flex: 1, backgroundColor: pageBackground }}
            />

            {/* Read-only shield by default so sheet gestures never move the agent's cursor */}
            {!control ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.takeControl}
                onPress={() => {
                  haptics.tap();
                  setControl(true);
                }}
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  left: 0,
                }}
              />
            ) : null}

            {/* Floating control bar */}
            <View
              pointerEvents="box-none"
              style={{
                position: 'absolute',
                left: 10,
                right: 10,
                bottom: 10,
                flexDirection: copy.isRtl ? 'row-reverse' : 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <Button
                variant={control ? 'default' : 'secondary'}
                size="sm"
                className="rounded-full border border-border"
                onPress={() => {
                  haptics.tap();
                  setControl((c) => !c);
                }}
              >
                <Icon as={control ? LockIcon : LockOpenIcon} size={13} />
                <Text className="text-[12px]">
                  {control ? copy.returnControl : copy.takeControl}
                </Text>
              </Button>

              <Button
                variant="secondary"
                size="sm"
                className="rounded-full border border-border"
                onPress={() => {
                  haptics.tap();
                  openPreview(desktopProxyUrl, title);
                }}
              >
                <Icon as={ArrowSquareOutIcon} size={13} />
                <Text className="text-[12px]">{copy.openFullScreen}</Text>
              </Button>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

// ─── Steps Inspector Pane ────────────────────────────────────────────────────

function StepsInspectorPane({
  sessionId,
  state,
  resolved,
  copy,
}: {
  sessionId: string;
  state: ReturnType<typeof deriveComputerState>;
  resolved: ReturnType<typeof resolveComputerStepIndex>;
  copy: ComputerCopy;
}) {
  const scrollRef = useRef<any>(null);
  const pinnedRef = useRef(true);
  const openPreview = useToolPreviewStore((s) => s.openPreview);
  const openFilePreview = useToolFilePreviewStore((s) => s.openPreview);
  const [showDetails, setShowDetails] = useState(false);

  const step = resolved.step;

  // Reset Details disclosure when switching steps so raw dumps stay collapsed by default.
  useEffect(() => {
    setShowDetails(false);
  }, [step?.id]);

  // Auto-scroll live terminal output while pinned to end; pause when user scrolls up.
  useEffect(() => {
    if (resolved.isLive && pinnedRef.current && step?.surface === 'terminal' && step?.output.text) {
      scrollRef.current?.scrollToEnd?.({ animated: false });
    }
  }, [resolved.isLive, step?.id, step?.surface, step?.output.text]);

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
  const hasRealLocalPreview = step.surface === 'browser' && isLocalhostPreviewUrl(step.url);
  const isBrowserOrTool = step.surface === 'browser' || step.surface === 'mcp';
  const hasCollapsibleDetails =
    isBrowserOrTool && Boolean(step.output.text || step.argsPreview || (step.surface === 'browser' && step.command));

  return (
    <View testID="computer-steps-pane" style={{ flex: 1 }} className="px-4">
      <View style={{ flex: 1 }} className="overflow-hidden rounded-3xl border border-border bg-card">
        {/* Step card header — never shows "bash" for browser steps */}
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
            <Text
              testID="computer-step-header-title"
              className="shrink text-[13px] font-roobert-medium text-foreground"
              numberOfLines={1}
            >
              {step.title}
            </Text>
            <Text variant="muted" className="flex-1 text-[12px]" numberOfLines={1}>
              {step.humanDetail}
            </Text>
          </View>

          {hasRealLocalPreview && step.url ? (
            <Button
              testID="computer-open-preview-btn"
              variant="secondary"
              size="sm"
              className="rounded-full"
              onPress={() => openPreview(step.url!, step.pageTitle || step.humanDetail)}
            >
              <Icon as={ArrowSquareOutIcon} size={13} />
              <Text className="text-[12px]">{copy.openPreview}</Text>
            </Button>
          ) : step.surface === 'files' && step.diffStats ? (
            <View className="flex-row items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5">
              <Text className="text-[11px] tabular-nums" style={{ color: THEME.accent.green }}>
                {`+${step.diffStats.additions}`}
              </Text>
              <Text className="text-[11px] tabular-nums" style={{ color: THEME.accent.red }}>
                {`-${step.diffStats.deletions}`}
              </Text>
            </View>
          ) : step.surface === 'terminal' && typeof step.exitCode === 'number' ? (
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
          {step.networkRestricted ? (
            <View className="flex-row items-start gap-2 rounded-2xl border border-border bg-muted/50 px-3 py-2.5">
              <Icon as={WarningCircleIcon} size={15} color={THEME.accent.orange} />
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-[12.5px] font-roobert-medium text-foreground">
                  {copy.networkRestrictedHost(step.restrictedHost)}
                </Text>
                <Text className="text-[12px] leading-4 text-muted-foreground">
                  {copy.networkRestrictedHint(step.restrictedHost)}
                </Text>
              </View>
            </View>
          ) : null}

          {/* Browser URL & recorded frame */}
          {step.surface === 'browser' && step.url ? (
            <View className="flex-row items-center gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-2">
              <Icon as={GlobeIcon} size={14} className="text-muted-foreground" />
              <View className="min-w-0 flex-1">
                {step.pageTitle ? (
                  <Text className="text-[12.5px] font-roobert-medium text-foreground" numberOfLines={1}>
                    {step.pageTitle}
                  </Text>
                ) : null}
                <Text className="text-[11.5px] text-muted-foreground" numberOfLines={1}>
                  {step.url}
                </Text>
              </View>
            </View>
          ) : null}

          {step.screenshotUrl ? (
            <View className="overflow-hidden rounded-2xl border border-border bg-background">
              <Image
                source={{ uri: step.screenshotUrl }}
                style={{ width: '100%', height: 220 }}
                resizeMode="cover"
                accessibilityLabel={step.pageTitle || step.humanDetail}
              />
            </View>
          ) : null}

          {/* Terminal view: command + monospace output */}
          {step.surface === 'terminal' && step.command ? (
            <View className="rounded-2xl border border-border bg-muted/40 px-3 py-2">
              <Text style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 18 }} className="text-foreground">
                {`$ ${step.command}`}
              </Text>
            </View>
          ) : null}

          {/* Files view: path + diff lines */}
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

          {step.diffLines && step.diffLines.length > 0 ? (
            <View className="overflow-hidden rounded-2xl border border-border bg-background p-2.5">
              {step.diffLines.map((line, idx) => (
                <Text
                  key={`${step.id}-diff-${idx}`}
                  selectable
                  style={{
                    fontFamily: monoFont,
                    fontSize: 11.5,
                    lineHeight: 17,
                    color:
                      line.type === 'added'
                        ? THEME.accent.green
                        : line.type === 'removed'
                          ? THEME.accent.red
                          : undefined,
                  }}
                  className={line.type === 'unchanged' ? 'text-muted-foreground' : undefined}
                >
                  {`${line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '} ${line.text}`}
                </Text>
              ))}
            </View>
          ) : null}

          {step.errorText ? (
            <View className="rounded-2xl border border-destructive/30 bg-destructive/10 p-3">
              <Text style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 18 }} className="text-destructive">
                {step.errorText}
              </Text>
            </View>
          ) : null}

          {/* Terminal & File output rendered directly */}
          {!isBrowserOrTool && step.output.text && !(step.diffLines && step.diffLines.length > 0) ? (
            <Text
              selectable
              style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 18.5 }}
              className="text-foreground"
            >
              {step.output.text}
            </Text>
          ) : step.status === 'running' && !step.screenshotUrl ? (
            <View className="flex-row items-center gap-2 py-2">
              <SessionDotMatrix sessionId={sessionId} size={13} />
              <Text variant="muted" className="text-[13px]">
                {copy.working}
              </Text>
            </View>
          ) : null}

          {/* Raw browser / tool output (accessibility trees, logs, JSON args) lives inside collapsed Details */}
          {hasCollapsibleDetails ? (
            <View className="gap-2">
              <Pressable
                testID="computer-details-toggle"
                accessibilityRole="button"
                accessibilityState={{ expanded: showDetails }}
                onPress={() => {
                  haptics.tap();
                  setShowDetails((v) => !v);
                }}
                className="flex-row items-center justify-between rounded-2xl border border-border bg-background px-3 py-2 active:opacity-75"
              >
                <Text className="text-[12px] font-roobert-medium text-muted-foreground">
                  {showDetails ? copy.detailsHide : copy.detailsShow}
                </Text>
                <Icon
                  as={showDetails ? CaretUpIcon : CaretDownIcon}
                  size={13}
                  className="text-muted-foreground"
                />
              </Pressable>

              {showDetails ? (
                <View
                  testID="computer-details-body"
                  className="gap-2 rounded-2xl border border-border bg-background p-3"
                >
                  {step.argsPreview ? (
                    <Text
                      selectable
                      style={{ fontFamily: monoFont, fontSize: 11, lineHeight: 16.5 }}
                      className="text-muted-foreground"
                    >
                      {step.argsPreview}
                    </Text>
                  ) : null}
                  {step.output.text ? (
                    <Text
                      selectable
                      style={{ fontFamily: monoFont, fontSize: 11.5, lineHeight: 17 }}
                      className="text-foreground"
                    >
                      {step.output.text}
                    </Text>
                  ) : null}
                </View>
              ) : null}
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
    </View>
  );
}

// ─── Shared Status Notice ────────────────────────────────────────────────────

function StatusNotice({
  icon,
  title,
  message,
  loading,
  copy,
}: {
  icon: AppIcon;
  title: string;
  message: string;
  loading?: boolean;
  copy: ComputerCopy;
}) {
  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="w-full max-w-[320px] items-center gap-3 rounded-3xl border border-border bg-card p-6">
        {loading ? (
          <KortixLoader size="small" />
        ) : (
          <View className="h-11 w-11 items-center justify-center rounded-2xl border border-border bg-background">
            <Icon as={icon} size={20} className="text-muted-foreground" />
          </View>
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
    </View>
  );
}
