/**
 * ComputerDock — Kortix-styled session computer header integrated into ONE
 * unified elevated rounded container with the chat composer (`SessionPage.tsx`).
 *
 * Geometry:
 * - `ComputerDockShell` draws the shared elevated rounded frame behind both
 *   the dock header and `SessionChatInput` (`SessionChatInput.tsx` internals
 *   are never modified).
 * - A `64x48` (`borderRadius: 14`) thumbnail card overlaps the container's
 *   top-start edge (top-left in LTR, top-right in RTL) with a real preview:
 *   low-rate (<=0.5 fps, foreground-only) desktop PNG while using Browser,
 *   last lines for Terminal, filename + diff for Files, or a monitor glyph
 *   when inactive.
 * - To its right: semantic status dot + human label + one humanized detail
 *   line (domain, filename, or first command word — never raw commands or env
 *   vars) + optional step-count chip. Whole dock is one >=44dp tap target.
 */

import React, { memo, useCallback, useEffect, useMemo } from 'react';
import { Image, Pressable, View } from 'react-native';
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import type { SessionLogTurn } from '@kortix/sdk';

import { monoFont } from '@/components/session/tool/shared/styles';
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
  WarningCircleIcon,
  WifiSlashIcon,
} from '@/lib/icons';
import {
  deriveComputerDockView,
  deriveComputerState,
  getComputerCopy,
  type ComputerDockDotColor,
  type ComputerDockPreview,
} from '@/lib/session/computer-steps';
import { THEME } from '@/lib/utils/theme';
import { useComputerSheetStore } from '@/stores/computer-sheet-store';

import { useDesktopThumbnail } from './useDesktopThumbnail';

export interface ComputerDockProps {
  sessionId: string;
  turns: ReadonlyArray<SessionLogTurn>;
  isBusy: boolean;
  sandboxUrl?: string;
}

/**
 * Shared elevated rounded container that visually unites `ComputerDock` and
 * `SessionChatInput` into ONE card without altering `SessionChatInput.tsx`.
 *
 * `SessionChatInput` renders its inner `Composer` inside `px-4 pb-3 pt-1`
 * (`left: 16, right: 16, bottom: 12`). This shell anchors the shared elevated
 * backdrop to those exact edges (`left: 16, right: 16, top: 10, bottom: 12`)
 * so the dock header and composer share one continuous rounded contour, border,
 * and shadow, while leaving top space for the overlapping 64x48 thumbnail card.
 */
export function ComputerDockShell({
  active,
  children,
}: {
  active: boolean;
  children?: React.ReactNode;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  if (!active) {
    return <View>{children}</View>;
  }

  return (
    <View style={{ position: 'relative' }} testID="session-computer-shell">
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 16,
          right: 16,
          top: 10,
          bottom: 12,
          borderRadius: 26,
          borderWidth: 1,
          borderColor: isDark ? THEME.dark.border : THEME.light.border,
          backgroundColor: isDark ? THEME.dark.card : THEME.light.card,
          shadowColor: THEME.light.foreground,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: isDark ? 0.28 : 0.07,
          shadowRadius: 12,
          elevation: 3,
        }}
      />
      {children}
    </View>
  );
}

function resolveDotColor(color: ComputerDockDotColor, isDark: boolean): string {
  switch (color) {
    case 'blue':
      return THEME.accent.blue;
    case 'green':
      return THEME.accent.green;
    case 'amber':
      return THEME.accent.orange;
    case 'red':
      return THEME.accent.red;
    case 'grey':
    default:
      return isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  }
}

const StatusDot = memo(function StatusDot({
  color,
  animated,
  isDark,
}: {
  color: ComputerDockDotColor;
  animated: boolean;
  isDark: boolean;
}) {
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (animated) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(0.35, { duration: 750, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 750, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
    } else {
      pulse.value = 1;
    }
  }, [animated, pulse]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: pulse.value,
    transform: [{ scale: 0.9 + 0.1 * pulse.value }],
  }));

  return (
    <Reanimated.View
      testID={`computer-dock-dot-${color}`}
      style={[
        {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: resolveDotColor(color, isDark),
        },
        animStyle,
      ]}
    />
  );
});

const ThumbnailCard = memo(function ThumbnailCard({
  preview,
  isDark,
}: {
  preview: ComputerDockPreview;
  isDark: boolean;
}) {
  const cardBg = isDark ? THEME.dark.background : THEME.light.background;
  const borderColor = isDark ? THEME.dark.border : THEME.light.border;

  return (
    <View
      testID={`computer-dock-thumb-${preview.kind}`}
      style={{
        width: 64,
        height: 48,
        marginTop: -10,
        borderRadius: 14,
        borderWidth: 1,
        borderColor,
        backgroundColor: cardBg,
        overflow: 'hidden',
        shadowColor: THEME.light.foreground,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: isDark ? 0.35 : 0.1,
        shadowRadius: 8,
        elevation: 4,
      }}
    >
      {preview.kind === 'terminal' ? (
        <View className="flex-1 justify-between px-1.5 py-1">
          <View className="flex-row items-center gap-0.5">
            <View className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <View className="h-1 w-1 rounded-full bg-muted-foreground/35" />
            <View className="h-1 w-1 rounded-full bg-muted-foreground/25" />
          </View>
          <View className="gap-0.5">
            {preview.lines.slice(0, 2).map((line, i) => (
              <Text
                key={i}
                numberOfLines={1}
                style={{ fontFamily: monoFont, fontSize: 7, lineHeight: 9 }}
                className={i === 0 ? 'text-foreground' : 'text-muted-foreground'}
              >
                {line}
              </Text>
            ))}
          </View>
        </View>
      ) : preview.kind === 'browser' ? (
        preview.screenshotUrl ? (
          <Image
            testID="computer-dock-thumb-image"
            source={{ uri: preview.screenshotUrl }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
        ) : (
          <View className="flex-1 justify-between p-1.5">
            <View className="flex-row items-center gap-1 rounded-md bg-muted/60 px-1 py-0.5">
              <Icon
                as={preview.restricted ? WarningCircleIcon : GlobeIcon}
                size={8}
                color={preview.restricted ? THEME.accent.orange : undefined}
                className={preview.restricted ? undefined : 'text-muted-foreground'}
              />
              <Text
                numberOfLines={1}
                style={{ fontSize: 6.5, lineHeight: 8.5 }}
                className="flex-1 text-foreground"
              >
                {preview.host}
              </Text>
            </View>
            <View className="gap-1 px-0.5">
              <View className="h-1 w-9 rounded-full bg-muted-foreground/25" />
              <View className="h-1 w-11 rounded-full bg-muted-foreground/15" />
            </View>
          </View>
        )
      ) : preview.kind === 'files' ? (
        <View className="flex-1 justify-between p-1.5">
          <View className="flex-row items-center gap-1">
            <Icon as={FileCodeIcon} size={9} className="text-muted-foreground" />
            <Text
              numberOfLines={1}
              style={{ fontFamily: monoFont, fontSize: 7, lineHeight: 9 }}
              className="flex-1 text-foreground"
            >
              {preview.fileName}
            </Text>
          </View>
          <View className="flex-row items-center gap-1">
            {typeof preview.additions === 'number' ? (
              <Text style={{ fontSize: 7, color: THEME.accent.green }}>
                {`+${preview.additions}`}
              </Text>
            ) : null}
            {typeof preview.deletions === 'number' ? (
              <Text style={{ fontSize: 7, color: THEME.accent.red }}>
                {`-${preview.deletions}`}
              </Text>
            ) : null}
          </View>
        </View>
      ) : preview.kind === 'mcp' ? (
        <View className="flex-1 justify-between p-1.5">
          <View className="flex-row items-center gap-1">
            <Icon as={CpuIcon} size={9} className="text-muted-foreground" />
            <Text
              numberOfLines={1}
              style={{ fontSize: 7, lineHeight: 9 }}
              className="flex-1 font-roobert-medium text-foreground"
            >
              {preview.label}
            </Text>
          </View>
          {preview.snippet ? (
            <Text
              numberOfLines={2}
              style={{ fontSize: 6.5, lineHeight: 8.5 }}
              className="text-muted-foreground"
            >
              {preview.snippet}
            </Text>
          ) : null}
        </View>
      ) : (
        <View className="flex-1 items-center justify-center">
          <Icon
            as={
              preview.reason === 'offline'
                ? WifiSlashIcon
                : preview.reason === 'error' || preview.reason === 'network_restricted'
                  ? WarningCircleIcon
                  : MonitorIcon
            }
            size={17}
            color={
              preview.reason === 'error'
                ? THEME.accent.red
                : preview.reason === 'network_restricted'
                  ? THEME.accent.orange
                  : undefined
            }
            className={
              preview.reason === 'error' || preview.reason === 'network_restricted'
                ? undefined
                : 'text-muted-foreground/60'
            }
          />
        </View>
      )}
    </View>
  );
});

function ComputerDockImpl({ sessionId, turns, isBusy, sandboxUrl }: ComputerDockProps) {
  const { currentLanguage, t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isOnline = useOnlineStatus();
  const isOffline = !isOnline;
  const reachability = useSandboxReachability(sandboxUrl);
  const openComputer = useComputerSheetStore((s) => s.openComputer);
  const isSheetOpen = useComputerSheetStore((s) => s.openSessionId === sessionId);

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

  // Low-rate (<=0.5 fps) desktop screenshot ONLY while Browser is active,
  // app is foreground, and the full sheet is closed.
  const pollBrowserThumbnail =
    state.activeSurface === 'browser' &&
    state.status === 'working' &&
    !isSheetOpen &&
    Boolean(state.desktopScreenshotUrl);

  const liveThumbUri = useDesktopThumbnail(state.desktopScreenshotUrl, pollBrowserThumbnail);

  const dockView = useMemo(
    () => deriveComputerDockView(state, currentLanguage, t, liveThumbUri),
    [state, currentLanguage, t, liveThumbUri],
  );

  const handlePress = useCallback(() => {
    haptics.tap();
    const defaultTab =
      state.activeSurface === 'browser' && state.desktopProxyUrl ? 'desktop' : 'steps';
    openComputer(sessionId, defaultTab);
  }, [openComputer, sessionId, state.activeSurface, state.desktopProxyUrl]);

  // Hide only when there are zero steps, idle, and no sandbox is attached yet.
  if (state.status === 'empty' && !sandboxUrl) {
    return null;
  }

  const stepCount = state.steps.length;

  return (
    <View
      testID="session-computer-dock"
      style={{
        paddingHorizontal: 16,
        paddingTop: 10,
        minHeight: 54,
        overflow: 'visible',
      }}
    >
      <Pressable
        testID="session-computer-dock-button"
        accessibilityRole="button"
        accessibilityLabel={`${copy.computerTitle}: ${dockView.label}${dockView.detail ? `, ${dockView.detail}` : ''}`}
        onPress={handlePress}
        style={{ minHeight: 44, overflow: 'visible' }}
        className="active:opacity-80"
      >
        <View
          className={
            copy.isRtl
              ? 'flex-row-reverse items-center justify-between gap-2.5 px-3 pb-1.5 pt-1'
              : 'flex-row items-center justify-between gap-2.5 px-3 pb-1.5 pt-1'
          }
          style={{ overflow: 'visible' }}
        >
          <View
            className={
              copy.isRtl
                ? 'min-w-0 flex-1 flex-row-reverse items-center gap-2.5'
                : 'min-w-0 flex-1 flex-row items-center gap-2.5'
            }
            style={{ overflow: 'visible' }}
          >
            <ThumbnailCard preview={dockView.preview} isDark={isDark} />

            <View className="min-w-0 flex-1 justify-center">
              <View
                className={
                  copy.isRtl
                    ? 'flex-row-reverse items-center gap-1.5'
                    : 'flex-row items-center gap-1.5'
                }
              >
                <StatusDot
                  color={dockView.dotColor}
                  animated={dockView.dotAnimated}
                  isDark={isDark}
                />
                <Text
                  testID="computer-dock-label"
                  className="shrink text-[13.5px] font-roobert-medium text-foreground"
                  numberOfLines={1}
                  style={copy.isRtl ? { textAlign: 'right' } : undefined}
                >
                  {dockView.label}
                </Text>
              </View>

              {dockView.detail ? (
                <Text
                  testID="computer-dock-detail"
                  variant="muted"
                  className="text-[11.5px] leading-4"
                  numberOfLines={1}
                  style={copy.isRtl ? { textAlign: 'right' } : undefined}
                >
                  {dockView.detail}
                </Text>
              ) : null}
            </View>
          </View>

          <View
            className={
              copy.isRtl
                ? 'flex-row-reverse items-center gap-1.5 pl-0.5'
                : 'flex-row items-center gap-1.5 pr-0.5'
            }
          >
            {stepCount > 0 ? (
              <View className="rounded-full border border-border bg-background/80 px-2 py-0.5">
                <Text className="text-[10.5px] tabular-nums text-muted-foreground">
                  {copy.stepsCount(stepCount)}
                </Text>
              </View>
            ) : null}
            <Icon as={CaretUpIcon} size={13} className="text-muted-foreground" />
          </View>
        </View>
      </Pressable>
    </View>
  );
}

export const ComputerDock = memo(ComputerDockImpl);
