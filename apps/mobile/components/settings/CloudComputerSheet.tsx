/**
 * CloudComputerSheet — full per-user Daytona management surface for Settings.
 *
 * Shows live connection details (`orgId`, `region`, `snapshotStatus`,
 * `orgSwitched` warning), lets users retry a failed/inactive runtime snapshot
 * (`POST /v1/onboarding/daytona/retry`), open Daytona billing, switch/reconnect
 * accounts (`DaytonaStepView`), or disconnect cleanly with confirmation
 * (`DELETE /v1/onboarding/daytona/disconnect`).
 */

import * as React from 'react';
import { Linking, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DaytonaStepView } from '@/components/auth/DaytonaStepView';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/kortix/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import { haptics } from '@/lib/haptics';
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CpuIcon,
  LinkBreakIcon,
  WarningCircleIcon,
  WifiSlashIcon,
} from '@/lib/icons';
import { useOnlineStatus } from '@/lib/network/use-online-status';
import {
  deriveCloudComputerView,
  getCloudComputerCopy,
} from '@/lib/onboarding/cloud-computer-view';
import {
  disconnectDaytona,
  retryDaytonaSnapshot,
  type DaytonaOnboardingStatus,
} from '@/lib/onboarding/daytona-client';
import { THEME } from '@/lib/utils/theme';

const DAYTONA_BILLING_URL = 'https://app.daytona.io/dashboard/billing';

export interface CloudComputerSheetProps {
  sheetRef: React.RefObject<SheetRef | null>;
  status: DaytonaOnboardingStatus | undefined;
  isLoading: boolean;
  errorMessage: string | null;
  onRefresh: () => void;
  onStatusUpdated: (next: DaytonaOnboardingStatus | null) => void;
}

export function CloudComputerSheet({
  sheetRef,
  status,
  isLoading,
  errorMessage,
  onRefresh,
  onStatusUpdated,
}: CloudComputerSheetProps) {
  const insets = useSafeAreaInsets();
  const { currentLanguage } = useLanguage();
  const isOnline = useOnlineStatus();
  const copy = React.useMemo(() => getCloudComputerCopy(currentLanguage), [currentLanguage]);

  const view = React.useMemo(
    () =>
      deriveCloudComputerView({
        isLoading,
        isOffline: !isOnline,
        errorMessage,
        status,
        locale: currentLanguage,
      }),
    [isLoading, isOnline, errorMessage, status, currentLanguage],
  );

  const [showConnectWizard, setShowConnectWizard] = React.useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  const [retryingSnapshot, setRetryingSnapshot] = React.useState(false);
  const [disconnecting, setDisconnecting] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setShowConnectWizard(view.showConnectFlowByDefault);
    setConfirmDisconnect(false);
    setActionError(null);
  }, [view.showConnectFlowByDefault, status?.orgId, status?.connected]);

  const handleRetrySnapshot = React.useCallback(async () => {
    if (retryingSnapshot) return;
    haptics.tap();
    setRetryingSnapshot(true);
    setActionError(null);
    try {
      const updated = await retryDaytonaSnapshot();
      onStatusUpdated(updated);
      haptics.success();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not retry snapshot setup.');
      haptics.warning();
    } finally {
      setRetryingSnapshot(false);
    }
  }, [retryingSnapshot, onStatusUpdated]);

  const handleDisconnect = React.useCallback(async () => {
    if (disconnecting) return;
    haptics.medium();
    setDisconnecting(true);
    setActionError(null);
    try {
      await disconnectDaytona();
      setConfirmDisconnect(false);
      onStatusUpdated({
        connected: false,
        orgId: null,
        region: null,
        snapshotName: null,
        snapshotStatus: null,
        snapshotError: null,
      });
      haptics.success();
      sheetRef.current?.close();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not disconnect Daytona.');
      haptics.warning();
    } finally {
      setDisconnecting(false);
    }
  }, [disconnecting, onStatusUpdated, sheetRef]);

  return (
    <Sheet ref={sheetRef} enablePanDownToClose>
      <SheetHeader title={copy.sheetTitle} />
      <SheetBody>
        {showConnectWizard ? (
          <DaytonaStepView
            mode="reconnect"
            onComplete={({ status: nextStatus }) => {
              if (nextStatus) onStatusUpdated(nextStatus);
              onRefresh();
              setShowConnectWizard(false);
              sheetRef.current?.close();
            }}
            onCancel={() => {
              if (status?.connected && !status.reconnectRequired) {
                setShowConnectWizard(false);
              } else {
                sheetRef.current?.close();
              }
            }}
          />
        ) : view.state === 'loading' ? (
          <View className="items-center justify-center py-10">
            <KortixLoader size="small" />
          </View>
        ) : view.state === 'offline' ? (
          <View className="items-center gap-2.5 px-4 py-8">
            <Icon as={WifiSlashIcon} size={22} className="text-muted-foreground" />
            <Text className="text-[15px] font-roobert-medium text-foreground">
              {view.headline}
            </Text>
            <Text variant="muted" className="text-center text-[13px] leading-5">
              {view.subtitle}
            </Text>
          </View>
        ) : view.state === 'error' ? (
          <View className="items-center gap-3 px-4 py-8">
            <Icon as={WarningCircleIcon} size={22} color={THEME.accent.orange} />
            <Text className="text-center text-[15px] font-roobert-medium text-foreground">
              {view.headline}
            </Text>
            <Text variant="muted" className="text-center text-[13px] leading-5">
              {view.subtitle}
            </Text>
            <Button variant="secondary" size="sm" className="rounded-full" onPress={onRefresh}>
              <Icon as={ArrowCounterClockwiseIcon} size={14} />
              <Text>{copy.retry}</Text>
            </Button>
          </View>
        ) : (
          <View className="gap-4 px-4 pb-4 pt-1">
            {/* Connection status card */}
            <View className="gap-3 rounded-3xl border border-border bg-card p-4">
              <View
                className={
                  view.isRtl
                    ? 'flex-row-reverse items-center gap-2.5'
                    : 'flex-row items-center gap-2.5'
                }
              >
                <Icon
                  as={
                    view.state === 'connected_degraded'
                      ? WarningCircleIcon
                      : view.state === 'connected_healthy'
                        ? CheckCircleIcon
                        : CpuIcon
                  }
                  size={18}
                  color={
                    view.state === 'connected_degraded'
                      ? THEME.accent.orange
                      : view.state === 'connected_healthy'
                        ? THEME.dark.success
                        : undefined
                  }
                  className="text-foreground"
                />
                <Text className="flex-1 text-[15px] font-roobert-medium text-foreground">
                  {view.headline}
                </Text>
              </View>

              {view.subtitle ? (
                <Text variant="muted" className="text-[13px] leading-5">
                  {view.subtitle}
                </Text>
              ) : null}

              {/* Key-value details */}
              <View className="gap-2 rounded-2xl border border-border bg-muted/30 p-3">
                {view.orgLabel ? (
                  <DetailRow label={copy.organization} value={view.orgLabel} isRtl={view.isRtl} />
                ) : null}
                {view.regionLabel ? (
                  <DetailRow label={copy.region} value={view.regionLabel} isRtl={view.isRtl} />
                ) : null}
                {view.snapshotBadge ? (
                  <DetailRow
                    label={copy.runtimeImage}
                    value={view.snapshotBadge}
                    isRtl={view.isRtl}
                  />
                ) : null}
              </View>

              {view.orgSwitchNotice ? (
                <View className="rounded-2xl border border-border bg-muted/40 px-3 py-2">
                  <Text className="text-[12px] leading-4 text-muted-foreground">
                    {view.orgSwitchNotice}
                  </Text>
                </View>
              ) : null}

              {actionError ? (
                <Text className="text-[12px] text-destructive">{actionError}</Text>
              ) : null}
            </View>

            {/* Primary & recovery actions */}
            <View className="gap-2.5">
              {view.canRetrySnapshot ? (
                <Button
                  variant="default"
                  size="lg"
                  className="rounded-full"
                  disabled={retryingSnapshot}
                  onPress={() => void handleRetrySnapshot()}
                >
                  <Icon as={ArrowCounterClockwiseIcon} size={15} />
                  <Text>{retryingSnapshot ? copy.retryingImage : copy.retryImage}</Text>
                </Button>
              ) : null}

              <Button
                variant="secondary"
                size="lg"
                className="rounded-full"
                onPress={() => {
                  haptics.tap();
                  setShowConnectWizard(true);
                }}
              >
                <Icon as={CpuIcon} size={15} />
                <Text>{copy.switchAccount}</Text>
              </Button>

              <Button
                variant="secondary"
                size="lg"
                className="rounded-full"
                onPress={() => {
                  haptics.tap();
                  void Linking.openURL(DAYTONA_BILLING_URL);
                }}
              >
                <Icon as={ArrowSquareOutIcon} size={15} />
                <Text>{copy.openBilling}</Text>
              </Button>

              {view.canDisconnect && !confirmDisconnect ? (
                <Button
                  variant="ghost"
                  size="lg"
                  className="rounded-full"
                  onPress={() => {
                    haptics.warning();
                    setConfirmDisconnect(true);
                  }}
                >
                  <Icon as={LinkBreakIcon} size={15} className="text-destructive" />
                  <Text className="text-destructive">{copy.disconnect}</Text>
                </Button>
              ) : null}

              {confirmDisconnect ? (
                <View className="gap-3 rounded-3xl border border-destructive/30 bg-destructive/10 p-4">
                  <Text className="text-[14px] font-roobert-medium text-foreground">
                    {copy.disconnectConfirmTitle}
                  </Text>
                  <Text className="text-[12.5px] leading-5 text-muted-foreground">
                    {copy.disconnectConfirmBody}
                  </Text>
                  <View className="flex-row gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="flex-1 rounded-full"
                      disabled={disconnecting}
                      onPress={() => setConfirmDisconnect(false)}
                    >
                      <Text>{copy.cancel}</Text>
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="flex-1 rounded-full"
                      disabled={disconnecting}
                      onPress={() => void handleDisconnect()}
                    >
                      <Text>
                        {disconnecting ? copy.disconnecting : copy.disconnectConfirmAction}
                      </Text>
                    </Button>
                  </View>
                </View>
              ) : null}
            </View>
          </View>
        )}
      </SheetBody>
      <View style={{ height: insets.bottom }} />
    </Sheet>
  );
}

function DetailRow({
  label,
  value,
  isRtl,
}: {
  label: string;
  value: string;
  isRtl: boolean;
}) {
  return (
    <View
      className={
        isRtl
          ? 'flex-row-reverse items-center justify-between gap-3'
          : 'flex-row items-center justify-between gap-3'
      }
    >
      <Text variant="muted" className="text-[12px]">
        {label}
      </Text>
      <Text className="text-[12px] font-roobert-medium tabular-nums text-foreground">
        {value}
      </Text>
    </View>
  );
}
