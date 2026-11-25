/**
 * ComputerSheet — host-gated Kortix bottom sheet showing the session
 * computer's live tool steps (Terminal, Browser, Files with line diff, and
 * MCP/connector calls) plus a Prev / Live / Next step timeline.
 *
 * Host-gated mounting (`if (!isOpen) return null`) mirrors `ActivitySheetHost`:
 * `BottomSheetModal` mounts only when open and calls `present()` once on mount.
 * Never calls `dismiss()` before `present()` (which previously locked
 * `@gorhom/bottom-sheet` in `MODAL_STATUS.DISMISSING` so taps opened nothing).
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Image,
  Linking,
  Pressable,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SessionLogTurn } from '@kortix/sdk';
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
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CpuIcon,
  FileCodeIcon,
  GlobeIcon,
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
  getComputerCopy,
  resolveComputerStepIndex,
  type ComputerCopy,
  type ComputerStep,
  type ComputerSurface,
} from '@/lib/session/computer-steps';
import { THEME } from '@/lib/utils/theme';
import { useComputerSheetStore } from '@/stores/computer-sheet-store';
import { useTabStore } from '@/stores/tab-store';
import { useToolPreviewStore } from '@/stores/tool-preview-store';

const DAYTONA_BILLING_URL = 'https://app.daytona.io/dashboard/billing';
const SNAP_POINTS = ['90%'];

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

/**
 * Host component mounted once per session screen. Mounts the actual
 * `BottomSheetModal` ONLY when this session's sheet is open so `present()`
 * fires cleanly every time the dock is tapped.
 */
function ComputerSheetHostImpl({ sessionId, turns, isBusy, sandboxUrl }: ComputerSheetProps) {
  const isOpen = useComputerSheetStore((s) => s.openSessionId === sessionId);
  const closeComputer = useComputerSheetStore((s) => s.closeComputer);

  // Close the sheet if the user navigates to another session or page tab.
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

  // Never outlive the owning session screen.
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
  onClose,
}: ComputerSheetProps & { onClose: () => void }) {
  const modalRef = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const pageBackground = isDark ? THEME.dark.background : THEME.light.background;

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

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

  // Android hardware back closes the computer sheet cleanly.
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
        <SheetTitleRow title={copy.computerTitle} onClose={handleRequestClose} />

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
        ) : (
          <StepsInspectorPane
            sessionId={sessionId}
            state={state}
            resolved={resolved}
            copy={copy}
            onPrev={handleStepPrev}
            onNext={handleStepNext}
            onJumpLive={handleJumpLive}
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
}: {
  sessionId: string;
  state: ReturnType<typeof deriveComputerState>;
  resolved: ReturnType<typeof resolveComputerStepIndex>;
  copy: ComputerCopy;
  onPrev: () => void;
  onNext: () => void;
  onJumpLive: () => void;
}) {
  const scrollRef = useRef<any>(null);
  const pinnedRef = useRef(true);
  const openPreview = useToolPreviewStore((s) => s.openPreview);
  const openFilePreview = useToolFilePreviewStore((s) => s.openPreview);

  const step = resolved.step;

  // Auto-scroll live terminal/step output while pinned to end; pause when user scrolls up.
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
              onPress={() => openPreview(step.url!, step.pageTitle || step.subtitle)}
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
          {step.networkRestricted ? (
            <View className="flex-row items-start gap-2 rounded-2xl border border-border bg-muted/50 px-3 py-2.5">
              <Icon as={WarningCircleIcon} size={15} color={THEME.accent.orange} />
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-[12px] font-roobert-medium text-foreground">
                  {copy.networkRestricted}
                </Text>
                <Text className="text-[12px] leading-4 text-muted-foreground">
                  {copy.networkRestrictedHint}
                </Text>
              </View>
            </View>
          ) : null}

          {step.url ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => openPreview(step.url!, step.pageTitle || step.subtitle)}
              className="flex-row items-center gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-2 active:opacity-75"
            >
              <Icon as={GlobeIcon} size={14} className="text-muted-foreground" />
              <View className="min-w-0 flex-1">
                {step.pageTitle ? (
                  <Text className="text-[12px] font-roobert-medium text-foreground" numberOfLines={1}>
                    {step.pageTitle}
                  </Text>
                ) : null}
                <Text className="text-[11.5px] text-muted-foreground" numberOfLines={1}>
                  {step.url}
                </Text>
              </View>
              <Icon as={ArrowSquareOutIcon} size={13} className="text-muted-foreground" />
            </Pressable>
          ) : null}

          {step.screenshotUrl ? (
            <View className="overflow-hidden rounded-2xl border border-border bg-background">
              <Image
                source={{ uri: step.screenshotUrl }}
                style={{ width: '100%', height: 196 }}
                resizeMode="cover"
                accessibilityLabel={step.pageTitle || step.subtitle}
              />
            </View>
          ) : null}

          {step.command ? (
            <View className="rounded-2xl border border-border bg-muted/40 px-3 py-2">
              <Text style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 18 }} className="text-foreground">
                {`$ ${step.command}`}
              </Text>
            </View>
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

          {step.argsPreview ? (
            <View className="gap-1">
              <Text className="text-[11px] font-roobert-medium uppercase tracking-wide text-muted-foreground">
                {copy.argumentsLabel}
              </Text>
              <View className="rounded-2xl border border-border bg-muted/30 p-3">
                <Text style={{ fontFamily: monoFont, fontSize: 11.5, lineHeight: 17 }} className="text-muted-foreground">
                  {step.argsPreview}
                </Text>
              </View>
            </View>
          ) : null}

          {step.errorText ? (
            <View className="rounded-2xl border border-destructive/30 bg-destructive/10 p-3">
              <Text style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 18 }} className="text-destructive">
                {step.errorText}
              </Text>
            </View>
          ) : null}

          {step.output.text && !(step.diffLines && step.diffLines.length > 0) ? (
            <View className="gap-1">
              {step.surface === 'mcp' ? (
                <Text className="text-[11px] font-roobert-medium uppercase tracking-wide text-muted-foreground">
                  {copy.resultLabel}
                </Text>
              ) : null}
              <Text
                selectable
                style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 18.5 }}
                className="text-foreground"
              >
                {step.output.text}
              </Text>
            </View>
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
                backgroundColor: resolved.isLive ? THEME.accent.green : THEME.light.mutedForeground,
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
