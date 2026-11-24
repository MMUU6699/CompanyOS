/**
 * ComputerDock — compact Kortix-styled bar mounted directly above the session
 * composer (`SessionPage.tsx` `session-composer-area`).
 *
 * Uses `ComposerCard` (`rounded-3xl border border-border bg-background p-2`),
 * `SessionDotMatrix`, and `THEME` tokens so it pairs natively with the Kortix
 * composer without modifying `SessionChatInput.tsx`.
 */

import React, { memo, useCallback, useMemo } from 'react';
import { Pressable, View } from 'react-native';
import type { SessionLogTurn } from '@kortix/sdk';

import { ComposerCard } from '@/components/kortix/composer-card';
import { SessionDotMatrix } from '@/components/session/dot-matrix/session-dot-matrix';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import { useSandboxReachability } from '@/hooks/useSandboxReachability';
import { haptics } from '@/lib/haptics';
import { useOnlineStatus } from '@/lib/network/use-online-status';
import {
  CaretUpIcon,
  CpuIcon,
  FileCodeIcon,
  GlobeIcon,
  MonitorIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WifiSlashIcon,
  type AppIcon,
} from '@/lib/icons';
import {
  deriveComputerState,
  getComputerCopy,
  type ComputerSurface,
} from '@/lib/session/computer-steps';
import { THEME } from '@/lib/utils/theme';
import { useComputerSheetStore } from '@/stores/computer-sheet-store';

const SURFACE_ICONS: Record<ComputerSurface, AppIcon> = {
  terminal: TerminalWindowIcon,
  browser: GlobeIcon,
  files: FileCodeIcon,
  mcp: CpuIcon,
};

export interface ComputerDockProps {
  sessionId: string;
  turns: ReadonlyArray<SessionLogTurn>;
  isBusy: boolean;
  sandboxUrl?: string;
}

function ComputerDockImpl({ sessionId, turns, isBusy, sandboxUrl }: ComputerDockProps) {
  const { currentLanguage } = useLanguage();
  const isOnline = useOnlineStatus();
  const isOffline = !isOnline;
  const reachability = useSandboxReachability(sandboxUrl);
  const openComputer = useComputerSheetStore((s) => s.openComputer);

  const copy = useMemo(() => getComputerCopy(currentLanguage), [currentLanguage]);

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

  const handlePress = useCallback(() => {
    haptics.tap();
    openComputer(sessionId, 'steps');
  }, [openComputer, sessionId]);

  // Hide only when there are zero steps, the session is idle, and no sandbox is attached yet.
  if (state.status === 'empty' && !sandboxUrl) {
    return null;
  }

  const primaryLabel = (() => {
    switch (state.status) {
      case 'working':
        return state.activeStep ? state.activeStep.title : copy.working;
      case 'waking':
        return copy.waking;
      case 'stopped':
        return copy.stopped;
      case 'offline':
        return copy.offline;
      case 'error':
        return state.error?.title ?? 'Computer error';
      case 'empty':
      case 'idle':
      default:
        return state.activeStep ? state.activeStep.title : copy.computerTitle;
    }
  })();

  const secondaryLabel = (() => {
    if (state.status === 'error') return state.error?.message ?? null;
    if (state.status === 'offline') return copy.offlineHint;
    if (state.activeStep) return state.activeStep.subtitle;
    if (state.status === 'empty') return copy.idle;
    return null;
  })();

  const LeadingGlyph = (() => {
    if (state.status === 'working') {
      return <SessionDotMatrix sessionId={sessionId} size={14} />;
    }
    if (state.status === 'offline') {
      return <Icon as={WifiSlashIcon} size={15} className="text-muted-foreground" />;
    }
    if (state.status === 'error') {
      return <Icon as={WarningCircleIcon} size={15} color={THEME.accent.orange} />;
    }
    if (state.status === 'waking') {
      return (
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: THEME.accent.yellow,
          }}
        />
      );
    }
    const SurfaceIcon = state.activeStep ? SURFACE_ICONS[state.activeSurface] : MonitorIcon;
    return <Icon as={SurfaceIcon} size={15} className="text-muted-foreground" />;
  })();

  const stepCount = state.steps.length;

  return (
    <View className="px-4 pb-2" testID="session-computer-dock">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${copy.computerTitle}: ${primaryLabel}`}
        onPress={handlePress}
        className="active:opacity-80"
      >
        <ComposerCard
          className={
            copy.isRtl
              ? 'flex-row-reverse items-center justify-between gap-2.5'
              : 'flex-row items-center justify-between gap-2.5'
          }
        >
          <View
            className={
              copy.isRtl
                ? 'min-w-0 flex-1 flex-row-reverse items-center gap-2.5 px-2 py-0.5'
                : 'min-w-0 flex-1 flex-row items-center gap-2.5 px-2 py-0.5'
            }
          >
            <View className="h-5 w-5 items-center justify-center">{LeadingGlyph}</View>
            <View className="min-w-0 flex-1">
              <View
                className={
                  copy.isRtl
                    ? 'flex-row-reverse items-center gap-1.5'
                    : 'flex-row items-center gap-1.5'
                }
              >
                <Text
                  className="shrink text-[13px] font-roobert-medium text-foreground"
                  numberOfLines={1}
                  style={copy.isRtl ? { textAlign: 'right' } : undefined}
                >
                  {primaryLabel}
                </Text>
                {secondaryLabel ? (
                  <Text
                    variant="muted"
                    className="flex-1 text-[12px]"
                    numberOfLines={1}
                    style={copy.isRtl ? { textAlign: 'right' } : undefined}
                  >
                    {`· ${secondaryLabel}`}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>

          <View
            className={
              copy.isRtl
                ? 'flex-row-reverse items-center gap-1.5 pl-1.5'
                : 'flex-row items-center gap-1.5 pr-1.5'
            }
          >
            {stepCount > 0 ? (
              <View className="rounded-full border border-border bg-muted/50 px-2 py-0.5">
                <Text className="text-[11px] tabular-nums text-muted-foreground">
                  {copy.stepsCount(stepCount)}
                </Text>
              </View>
            ) : null}
            <Icon as={CaretUpIcon} size={14} className="text-muted-foreground" />
          </View>
        </ComposerCard>
      </Pressable>
    </View>
  );
}

export const ComputerDock = memo(ComputerDockImpl);
