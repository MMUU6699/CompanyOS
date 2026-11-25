/**
 * ComputerDock — Kortix-styled session computer preview card sitting flush
 * above the chat composer (`SessionPage.tsx` `session-composer-area`).
 *
 * Features a 72x56 rounded thumbnail card anchored to the top-start edge
 * (top-left in LTR, top-right in RTL) with a live mini-preview of the active
 * surface (terminal lines, browser frame/screenshot, file diff card, or
 * inactive monitor glyph) paired with a semantic status dot and pure-mapped
 * EN/AR label. Does not modify `SessionChatInput.tsx`.
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

export interface ComputerDockProps {
  sessionId: string;
  turns: ReadonlyArray<SessionLogTurn>;
  isBusy: boolean;
  sandboxUrl?: string;
}

function resolveDotHex(color: ComputerDockDotColor, isDark: boolean): string {
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

  const fill = resolveDotHex(color, isDark);

  return (
    <Reanimated.View
      testID={`computer-dock-dot-${color}`}
      style={[
        {
          width: 9,
          height: 9,
          borderRadius: 4.5,
          backgroundColor: fill,
        },
        animStyle,
      ]}
    />
  );
});

const ThumbnailPreview = memo(function ThumbnailPreview({
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
        width: 72,
        height: 56,
        borderRadius: 14,
        borderWidth: 1,
        borderColor,
        backgroundColor: cardBg,
        overflow: 'hidden',
      }}
    >
      {preview.kind === 'terminal' ? (
        <View className="flex-1 justify-between px-1.5 py-1.5">
          <View className="flex-row items-center gap-1">
            <View className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <View className="h-1 w-1 rounded-full bg-muted-foreground/35" />
            <View className="h-1 w-1 rounded-full bg-muted-foreground/25" />
          </View>
          <View className="gap-0.5">
            {preview.lines.slice(0, 3).map((line, i) => (
              <Text
                key={i}
                numberOfLines={1}
                style={{ fontFamily: monoFont, fontSize: 7.5, lineHeight: 9.5 }}
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
                style={{ fontSize: 7, lineHeight: 9 }}
                className="flex-1 text-foreground"
              >
                {preview.host}
              </Text>
            </View>
            <View className="gap-1 px-0.5">
              <View className="h-1.5 w-10 rounded-full bg-muted-foreground/25" />
              <View className="h-1 w-12 rounded-full bg-muted-foreground/15" />
            </View>
          </View>
        )
      ) : preview.kind === 'files' ? (
        <View className="flex-1 justify-between p-1.5">
          <View className="flex-row items-center gap-1">
            <Icon as={FileCodeIcon} size={10} className="text-muted-foreground" />
            <Text
              numberOfLines={1}
              style={{ fontFamily: monoFont, fontSize: 7.5, lineHeight: 10 }}
              className="flex-1 text-foreground"
            >
              {preview.fileName}
            </Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            {typeof preview.additions === 'number' ? (
              <Text style={{ fontSize: 7.5, color: THEME.accent.green }}>
                {`+${preview.additions}`}
              </Text>
            ) : null}
            {typeof preview.deletions === 'number' ? (
              <Text style={{ fontSize: 7.5, color: THEME.accent.red }}>
                {`-${preview.deletions}`}
              </Text>
            ) : null}
          </View>
        </View>
      ) : preview.kind === 'mcp' ? (
        <View className="flex-1 justify-between p-1.5">
          <View className="flex-row items-center gap-1">
            <Icon as={CpuIcon} size={10} className="text-muted-foreground" />
            <Text
              numberOfLines={1}
              style={{ fontSize: 7.5, lineHeight: 10 }}
              className="flex-1 font-roobert-medium text-foreground"
            >
              {preview.label}
            </Text>
          </View>
          {preview.snippet ? (
            <Text
              numberOfLines={2}
              style={{ fontSize: 7, lineHeight: 9 }}
              className="text-muted-foreground"
            >
              {preview.snippet}
            </Text>
          ) : null}
        </View>
      ) : (
        <View className="flex-1 items-center justify-center gap-1 px-1">
          <Icon
            as={
              preview.reason === 'offline'
                ? WifiSlashIcon
                : preview.reason === 'error' || preview.reason === 'network_restricted'
                  ? WarningCircleIcon
                  : MonitorIcon
            }
            size={18}
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

  const dockView = useMemo(
    () => deriveComputerDockView(state, currentLanguage, t),
    [state, currentLanguage, t],
  );

  const handlePress = useCallback(() => {
    haptics.tap();
    openComputer(sessionId, 'steps');
  }, [openComputer, sessionId]);

  // Hide only when there are zero steps, the session is idle, and no sandbox is attached yet.
  if (state.status === 'empty' && !sandboxUrl) {
    return null;
  }

  const stepCount = state.steps.length;

  return (
    <View className="px-4 pb-1.5" testID="session-computer-dock">
      <Pressable
        testID="session-computer-dock-button"
        accessibilityRole="button"
        accessibilityLabel={`${copy.computerTitle}: ${dockView.label}`}
        onPress={handlePress}
        className="active:opacity-80"
      >
        <View
          className={
            copy.isRtl
              ? 'flex-row-reverse items-center justify-between gap-3 rounded-3xl border border-border bg-card px-2.5 py-2'
              : 'flex-row items-center justify-between gap-3 rounded-3xl border border-border bg-card px-2.5 py-2'
          }
        >
          {/* Left (or Right in RTL) rounded 72x56 thumbnail card + dot + pure label */}
          <View
            className={
              copy.isRtl
                ? 'min-w-0 flex-1 flex-row-reverse items-center gap-3'
                : 'min-w-0 flex-1 flex-row items-center gap-3'
            }
          >
            <ThumbnailPreview preview={dockView.preview} isDark={isDark} />

            <View className="min-w-0 flex-1 gap-0.5">
              <View
                className={
                  copy.isRtl
                    ? 'flex-row-reverse items-center gap-2'
                    : 'flex-row items-center gap-2'
                }
              >
                <StatusDot
                  color={dockView.dotColor}
                  animated={dockView.dotAnimated}
                  isDark={isDark}
                />
                <Text
                  testID="computer-dock-label"
                  className="shrink text-[14px] font-roobert-medium text-foreground"
                  numberOfLines={1}
                  style={copy.isRtl ? { textAlign: 'right' } : undefined}
                >
                  {dockView.label}
                </Text>
              </View>

              {dockView.subtitle ? (
                <Text
                  variant="muted"
                  className="text-[12px]"
                  numberOfLines={1}
                  style={copy.isRtl ? { textAlign: 'right' } : undefined}
                >
                  {dockView.subtitle}
                </Text>
              ) : null}
            </View>
          </View>

          <View
            className={
              copy.isRtl
                ? 'flex-row-reverse items-center gap-1.5 pl-1'
                : 'flex-row items-center gap-1.5 pr-1'
            }
          >
            {stepCount > 0 ? (
              <View className="rounded-full border border-border bg-background px-2 py-0.5">
                <Text className="text-[11px] tabular-nums text-muted-foreground">
                  {copy.stepsCount(stepCount)}
                </Text>
              </View>
            ) : null}
            <Icon as={CaretUpIcon} size={14} className="text-muted-foreground" />
          </View>
        </View>
      </Pressable>
    </View>
  );
}

export const ComputerDock = memo(ComputerDockImpl);
