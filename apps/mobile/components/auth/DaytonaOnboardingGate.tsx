/**
 * Post-auth Daytona Cloud Computer gate (Mobile).
 *
 * - Claims any Step 1 `claimToken` or manual key captured before login and
 *   clears temporary storage immediately.
 * - Returns `null` immediately for returning users whose snapshot is `active`.
 * - Renders a polished 3-stage vertical setup progress screen while Daytona
 *   pulls/activates the pinned GHCR image.
 * - Renders a calm, structured error recovery card (zero raw JSON, zero emojis,
 *   smart primary CTA: Reconnect Daytona for `DAYTONA_REGION_REQUIRED` /
 *   `DAYTONA_RECONNECT_REQUIRED`, Retry setup for transient errors, collapsible
 *   manual key fallback, full Light/Dark + EN/AR support).
 */

import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSegments } from 'expo-router';
import { useColorScheme } from 'nativewind';

import {
  DaytonaStepView,
  useMobileOnboardingLocale,
} from '@/components/auth/DaytonaStepView';
import { KortixLogo } from '@/components/kortix/KortixLogo';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts';
import { useSignOutAndRoute } from '@/hooks/useSignOutAndRoute';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  KeyIcon,
  WarningCircleIcon,
} from '@/lib/icons';
import {
  DAYTONA_STATUS_QUERY_KEY,
  type DaytonaOnboardingErrorCode,
  type DaytonaOnboardingStatus,
  claimDaytonaConnect,
  clearAllPendingDaytonaState,
  fetchDaytonaOnboardingStatus,
  inferDaytonaErrorCode,
  readPendingDaytonaClaim,
  readPendingManualDaytonaKey,
  sanitizeUiErrorMessage,
  saveManualDaytonaKey,
  subscribeDaytonaReconnect,
} from '@/lib/onboarding/daytona-client';
import { haptics } from '@/lib/haptics';
import { THEME, withAlpha } from '@/lib/utils/theme';

interface GateCopy {
  connecting: string;
  setupTitle: string;
  setupSubtitle: string;
  stageRegion: string;
  stagePull: string;
  stageActivate: string;
  stageReady: string;
  oneTimeHint: string;
  checkNow: string;
  signOut: string;
  retrySetup: string;
  reconnectCta: string;
  manualToggle: string;
  manualSave: string;
  manualValidating: string;
  manualInvalid: string;
  errorTitleRegion: string;
  errorBodyRegion: string;
  errorTitleReconnect: string;
  errorBodyReconnect: string;
  errorTitleEmail: string;
  errorBodyEmail: string;
  errorTitleQuota: string;
  errorBodyQuota: string;
  errorTitleGeneric: string;
  errorBodyGeneric: string;
}

const EN_GATE: GateCopy = {
  connecting: 'Connecting your Daytona workspace…',
  setupTitle: 'Preparing your private cloud computer',
  setupSubtitle: 'One-time workspace setup. This usually completes in under a minute.',
  stageRegion: 'Workspace region configured',
  stagePull: 'Downloading cloud computer image',
  stageActivate: 'Activating cloud computer image',
  stageReady: 'Ready to launch',
  oneTimeHint: 'You will only see this screen once per Daytona workspace.',
  checkNow: 'Check status',
  signOut: 'Sign out',
  retrySetup: 'Retry setup',
  reconnectCta: 'Reconnect Daytona',
  manualToggle: 'Advanced: Paste Daytona API key',
  manualSave: 'Save API key',
  manualValidating: 'Validating…',
  manualInvalid: 'Enter a valid Daytona API key starting with dtn_.',
  errorTitleRegion: 'Workspace region required',
  errorBodyRegion:
    'Your Daytona workspace does not have a default region selected yet. Reconnect Daytona and Kortix will configure it automatically.',
  errorTitleReconnect: 'Reconnect your Daytona workspace',
  errorBodyReconnect:
    'Your Daytona connection expired or was revoked. Reconnect Daytona to resume your cloud computer.',
  errorTitleEmail: 'Verify your Daytona email',
  errorBodyEmail: 'Confirm your email address in Daytona, then tap retry to finish setup.',
  errorTitleQuota: 'Workspace limit reached',
  errorBodyQuota:
    'Your Daytona workspace reached its free compute or storage limit. Free up space in Daytona, then retry.',
  errorTitleGeneric: 'Cloud computer setup paused',
  errorBodyGeneric:
    'We could not finish preparing your cloud computer right now. Retry setup or reconnect Daytona.',
};

const AR_GATE: GateCopy = {
  connecting: 'جارٍ ربط مساحة عمل Daytona…',
  setupTitle: 'جارٍ تجهيز حاسوبك السحابي الخاص',
  setupSubtitle: 'إعداد لمرة واحدة لمساحة العمل. يستغرق عادة أقل من دقيقة.',
  stageRegion: 'تم ضبط منطقة مساحة العمل',
  stagePull: 'جارٍ تنزيل صورة الحاسوب السحابي',
  stageActivate: 'جارٍ تفعيل صورة الحاسوب السحابي',
  stageReady: 'جاهز للبدء',
  oneTimeHint: 'ستظهر هذه الشاشة مرة واحدة فقط لكل مساحة عمل Daytona.',
  checkNow: 'تحديث الحالة',
  signOut: 'تسجيل الخروج',
  retrySetup: 'إعادة المحاولة',
  reconnectCta: 'إعادة ربط Daytona',
  manualToggle: 'متقدم: لصق مفتاح Daytona API يدوياً',
  manualSave: 'حفظ مفتاح API',
  manualValidating: 'جارٍ التحقق…',
  manualInvalid: 'أدخل مفتاح Daytona API صالحاً يبدأ بـ dtn_.',
  errorTitleRegion: 'مطلوب تحديد منطقة مساحة العمل',
  errorBodyRegion:
    'لم يتم تعيين منطقة افتراضية في مساحة عمل Daytona بعد. أعد ربط Daytona وسيقوم Kortix بضبطها تلقائياً.',
  errorTitleReconnect: 'أعد ربط مساحة عمل Daytona',
  errorBodyReconnect:
    'انتهت صلاحية اتصال Daytona أو تم إلغاؤه. أعد ربط Daytona للمتابعة.',
  errorTitleEmail: 'تحقق من بريدك في Daytona',
  errorBodyEmail: 'أكّد عنوان بريدك الإلكتروني في Daytona ثم أعد المحاولة لإكمال الإعداد.',
  errorTitleQuota: 'تم الوصول إلى حد مساحة العمل',
  errorBodyQuota:
    'وصلت مساحة عمل Daytona إلى الحد المجاني للموارد أو التخزين. أفرغ مساحة في Daytona ثم أعد المحاولة.',
  errorTitleGeneric: 'توقف إعداد الحاسوب السحابي مؤقتاً',
  errorBodyGeneric:
    'تعذّر إكمال تجهيز الحاسوب السحابي الآن. أعد المحاولة أو أعد ربط Daytona.',
};

function resolveGateError(
  code: DaytonaOnboardingErrorCode,
  copy: GateCopy,
): { title: string; body: string; preferReconnect: boolean } {
  switch (code) {
    case 'DAYTONA_REGION_REQUIRED':
      return { title: copy.errorTitleRegion, body: copy.errorBodyRegion, preferReconnect: true };
    case 'DAYTONA_RECONNECT_REQUIRED':
      return {
        title: copy.errorTitleReconnect,
        body: copy.errorBodyReconnect,
        preferReconnect: true,
      };
    case 'DAYTONA_EMAIL_UNVERIFIED':
      return { title: copy.errorTitleEmail, body: copy.errorBodyEmail, preferReconnect: false };
    case 'DAYTONA_QUOTA_EXCEEDED':
      return { title: copy.errorTitleQuota, body: copy.errorBodyQuota, preferReconnect: false };
    default:
      return { title: copy.errorTitleGeneric, body: copy.errorBodyGeneric, preferReconnect: false };
  }
}

export function DaytonaOnboardingGate() {
  const { user, isAuthenticated, mfaRequired, isLoading: authLoading } = useAuthContext();
  const segments = useSegments() as string[];
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const colors = THEME[scheme];
  const { isAr } = useMobileOnboardingLocale();
  const copy = isAr ? AR_GATE : EN_GATE;
  const queryClient = useQueryClient();
  const { signingOut, signOutAndRoute } = useSignOutAndRoute();

  const userId = user?.id ?? null;
  const inAuthFlow = segments[0] === 'auth';
  const active = !authLoading && isAuthenticated && !mfaRequired && !!userId && !inAuthFlow;

  const [claimState, setClaimState] = React.useState<'idle' | 'claiming' | 'done'>('idle');
  const [claimError, setClaimError] = React.useState<string | null>(null);
  const [forcedReconnect, setForcedReconnect] = React.useState(false);
  const [showManual, setShowManual] = React.useState(false);
  const [manualKey, setManualKey] = React.useState('');
  const [manualSaving, setManualSaving] = React.useState(false);
  const [manualError, setManualError] = React.useState<string | null>(null);
  const claimAttemptedUserRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    return subscribeDaytonaReconnect(() => {
      setForcedReconnect(true);
      void queryClient.invalidateQueries({ queryKey: DAYTONA_STATUS_QUERY_KEY });
    });
  }, [queryClient]);

  React.useEffect(() => {
    if (!userId) {
      claimAttemptedUserRef.current = null;
      setClaimState('idle');
      setClaimError(null);
      setForcedReconnect(false);
      setShowManual(false);
      setManualKey('');
      setManualError(null);
    }
  }, [userId]);

  React.useEffect(() => {
    if (!active || !userId) return;
    if (claimAttemptedUserRef.current === userId) return;
    claimAttemptedUserRef.current = userId;

    let cancelled = false;
    const run = async () => {
      const pendingClaim = await readPendingDaytonaClaim();
      const pendingManualKey = readPendingManualDaytonaKey();
      if (!pendingClaim && !pendingManualKey) {
        if (!cancelled) setClaimState('done');
        return;
      }

      if (!cancelled) {
        setClaimState('claiming');
        setClaimError(null);
      }

      try {
        let status: DaytonaOnboardingStatus;
        if (pendingClaim) {
          status = await claimDaytonaConnect(pendingClaim.claimToken);
        } else {
          status = await saveManualDaytonaKey(pendingManualKey!);
        }
        await clearAllPendingDaytonaState();
        if (cancelled) return;
        queryClient.setQueryData(DAYTONA_STATUS_QUERY_KEY, status);
        setForcedReconnect(false);
      } catch (err) {
        await clearAllPendingDaytonaState();
        if (cancelled) return;
        setClaimError(
          sanitizeUiErrorMessage(
            err instanceof Error ? err.message : null,
            copy.errorBodyReconnect,
          ),
        );
      } finally {
        if (!cancelled) setClaimState('done');
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [active, copy.errorBodyReconnect, queryClient, userId]);

  const statusQuery = useQuery({
    queryKey: DAYTONA_STATUS_QUERY_KEY,
    queryFn: fetchDaytonaOnboardingStatus,
    enabled: active && claimState === 'done',
    staleTime: 15_000,
    retry: 1,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data?.connected || data.reconnectRequired) return false;
      if (
        data.snapshotStatus === 'pending' ||
        data.snapshotStatus === 'pulling' ||
        data.snapshotStatus === 'inactive'
      ) {
        return 3_000;
      }
      return false;
    },
  });

  if (!active) return null;

  if (claimState === 'claiming') {
    return (
      <View
        style={[StyleSheet.absoluteFill, { zIndex: 40 }]}
        className="items-center justify-center bg-background px-8">
        <KortixLoader size="large" />
        <Text variant="muted" className="mt-4 text-center">
          {copy.connecting}
        </Text>
      </View>
    );
  }

  if (claimState !== 'done' || (statusQuery.isPending && !statusQuery.data)) {
    return null;
  }

  const status = statusQuery.data;

  // Returning user fast path: connected and snapshot active -> zero extra screens.
  if (
    !forcedReconnect &&
    status?.connected &&
    !status.reconnectRequired &&
    status.snapshotStatus === 'active'
  ) {
    return null;
  }

  if (statusQuery.isError && !status && !forcedReconnect) {
    return null;
  }

  // First-time GHCR snapshot preparation screen with crisp 3-stage vertical checklist.
  if (
    !forcedReconnect &&
    status?.connected &&
    !status.reconnectRequired &&
    (status.snapshotStatus === 'pending' ||
      status.snapshotStatus === 'pulling' ||
      status.snapshotStatus === 'inactive')
  ) {
    const activeStage =
      status.snapshotStatus === 'inactive' ? copy.stageActivate : copy.stagePull;
    return (
      <View
        style={[
          StyleSheet.absoluteFill,
          { zIndex: 40, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
        ]}
        className="items-center justify-center bg-background px-6">
        <View className="w-full max-w-md gap-5 rounded-3xl border border-border bg-card p-6">
          <View
            className="flex-row items-center justify-between"
            style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
            <KortixLogo variant="logomark" size={22} color={scheme} />
            <View className="rounded-full border border-border bg-background px-2.5 py-1">
              <Text variant="small" className="font-mono uppercase text-muted-foreground">
                {status.region || 'eu'}
              </Text>
            </View>
          </View>

          <View className="gap-1.5">
            <Text
              variant="h4"
              className="font-roobert-semibold text-foreground"
              style={{ textAlign: isAr ? 'right' : 'left' }}>
              {copy.setupTitle}
            </Text>
            <Text
              variant="muted"
              className="leading-5"
              style={{ textAlign: isAr ? 'right' : 'left' }}>
              {copy.setupSubtitle}
            </Text>
          </View>

          <View className="overflow-hidden rounded-2xl border border-border bg-background">
            <View
              className="flex-row items-center gap-3 px-4 py-3.5"
              style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
              <Icon as={CheckCircleIcon} size={17} color={colors.foreground} />
              <Text variant="small" className="font-roobert-medium text-foreground">
                {copy.stageRegion}
              </Text>
            </View>
            <View
              className="flex-row items-center gap-3 border-t border-border px-4 py-3.5"
              style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
              <KortixLoader size="small" />
              <Text variant="small" className="font-roobert-medium text-foreground">
                {activeStage}
              </Text>
            </View>
            <View
              className="flex-row items-center gap-3 border-t border-border px-4 py-3.5"
              style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
              <View className="size-4 rounded-full border border-border" />
              <Text variant="small" className="text-muted-foreground">
                {copy.stageReady}
              </Text>
            </View>
          </View>

          <Text
            variant="small"
            className="text-muted-foreground"
            style={{ textAlign: isAr ? 'right' : 'left' }}>
            {copy.oneTimeHint}
          </Text>

          <View
            className="flex-row items-center justify-between gap-2 border-t border-border pt-3"
            style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
            <Button
              variant="ghost"
              size="default"
              className="rounded-full"
              disabled={signingOut}
              onPress={signOutAndRoute}>
              <Text>{copy.signOut}</Text>
            </Button>
            <Button
              variant="outline"
              size="default"
              className="rounded-full"
              onPress={() => void statusQuery.refetch()}>
              <Icon as={ArrowClockwiseIcon} size={15} className="text-foreground" />
              <Text>{copy.checkNow}</Text>
            </Button>
          </View>
        </View>
      </View>
    );
  }

  // Polished error recovery card (never renders raw JSON).
  if (
    !forcedReconnect &&
    status?.connected &&
    (status.snapshotStatus === 'failed' || status.reconnectRequired)
  ) {
    const errCode = inferDaytonaErrorCode(
      status.snapshotErrorCode ?? (status.reconnectRequired ? 'DAYTONA_RECONNECT_REQUIRED' : null),
      status.snapshotError,
    );
    const presentation = resolveGateError(errCode, copy);

    const handleManualRecoverySave = async () => {
      const trimmed = manualKey.trim();
      if (!trimmed.startsWith('dtn_') || trimmed.length < 16) {
        setManualError(copy.manualInvalid);
        return;
      }
      haptics.tap();
      setManualError(null);
      setManualSaving(true);
      try {
        const nextStatus = await saveManualDaytonaKey(trimmed);
        await clearAllPendingDaytonaState();
        queryClient.setQueryData(DAYTONA_STATUS_QUERY_KEY, nextStatus);
        setShowManual(false);
        setManualKey('');
        haptics.success();
        void queryClient.invalidateQueries({ queryKey: DAYTONA_STATUS_QUERY_KEY });
      } catch (err) {
        setManualError(
          sanitizeUiErrorMessage(err instanceof Error ? err.message : null, copy.errorBodyGeneric),
        );
      } finally {
        setManualSaving(false);
      }
    };

    return (
      <View
        style={[
          StyleSheet.absoluteFill,
          { zIndex: 40, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
        ]}
        className="bg-background">
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            paddingHorizontal: 24,
            paddingVertical: 16,
          }}
          keyboardShouldPersistTaps="handled">
          <View className="w-full max-w-md self-center gap-5 rounded-3xl border border-border bg-card p-6">
            <View
              className="flex-row items-center justify-between"
              style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
              <KortixLogo variant="logomark" size={22} color={scheme} />
              <View
                className="size-9 items-center justify-center rounded-full"
                style={{ backgroundColor: withAlpha(colors.destructive, 0.14) }}>
                <Icon as={WarningCircleIcon} size={18} color={colors.destructive} />
              </View>
            </View>

            <View className="gap-1.5">
              <Text
                variant="h4"
                className="font-roobert-semibold text-foreground"
                style={{ textAlign: isAr ? 'right' : 'left' }}>
                {presentation.title}
              </Text>
              <Text
                variant="muted"
                className="leading-5"
                style={{ textAlign: isAr ? 'right' : 'left' }}>
                {presentation.body}
              </Text>
            </View>

            <View className="gap-2.5">
              {presentation.preferReconnect ? (
                <>
                  <Button
                    size="lg"
                    className="rounded-full"
                    onPress={() => {
                      haptics.tap();
                      setForcedReconnect(true);
                    }}>
                    <Icon as={ArrowSquareOutIcon} size={16} color={colors.primaryForeground} />
                    <Text>{copy.reconnectCta}</Text>
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    className="rounded-full"
                    onPress={() => {
                      haptics.tap();
                      void statusQuery.refetch();
                    }}>
                    <Icon as={ArrowClockwiseIcon} size={16} className="text-foreground" />
                    <Text>{copy.retrySetup}</Text>
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="lg"
                    className="rounded-full"
                    onPress={() => {
                      haptics.tap();
                      void statusQuery.refetch();
                    }}>
                    <Icon as={ArrowClockwiseIcon} size={16} color={colors.primaryForeground} />
                    <Text>{copy.retrySetup}</Text>
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    className="rounded-full"
                    onPress={() => {
                      haptics.tap();
                      setForcedReconnect(true);
                    }}>
                    <Icon as={ArrowSquareOutIcon} size={16} className="text-foreground" />
                    <Text>{copy.reconnectCta}</Text>
                  </Button>
                </>
              )}
            </View>

            <View className="border-t border-border pt-3">
              <Pressable
                onPress={() => {
                  haptics.tap();
                  setManualError(null);
                  setShowManual((v) => !v);
                }}
                accessibilityRole="button"
                className="flex-row items-center justify-between py-1"
                style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
                <View
                  className="flex-row items-center gap-2"
                  style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
                  <Icon as={KeyIcon} size={15} className="text-muted-foreground" />
                  <Text variant="small" className="font-roobert-medium text-muted-foreground">
                    {copy.manualToggle}
                  </Text>
                </View>
                <Icon
                  as={showManual ? CaretUpIcon : CaretDownIcon}
                  size={15}
                  className="text-muted-foreground"
                />
              </Pressable>

              {showManual ? (
                <View className="mt-3 gap-2.5">
                  <TextInput
                    value={manualKey}
                    onChangeText={(text) => {
                      setManualError(null);
                      setManualKey(text);
                    }}
                    placeholder="dtn_..."
                    placeholderTextColor={colors.mutedForeground}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!manualSaving}
                    returnKeyType="done"
                    onSubmitEditing={() => void handleManualRecoverySave()}
                    className="rounded-xl border border-border bg-background px-3.5 py-3 text-foreground"
                    style={{ color: colors.foreground }}
                  />
                  {manualError ? (
                    <Text variant="small" className="text-destructive">
                      {manualError}
                    </Text>
                  ) : null}
                  <Button
                    size="lg"
                    variant="secondary"
                    className="rounded-full"
                    disabled={manualSaving || manualKey.trim().length < 16}
                    onPress={() => void handleManualRecoverySave()}>
                    <Text>{manualSaving ? copy.manualValidating : copy.manualSave}</Text>
                  </Button>
                </View>
              ) : null}
            </View>

            <Button
              size="default"
              variant="ghost"
              className="rounded-full"
              disabled={signingOut}
              onPress={signOutAndRoute}>
              <Text>{copy.signOut}</Text>
            </Button>
          </View>
        </ScrollView>
      </View>
    );
  }

  // Unconnected or explicit reconnect mode.
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { zIndex: 40, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
      ]}
      className="bg-background">
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingHorizontal: 24,
          paddingVertical: 16,
        }}
        keyboardShouldPersistTaps="handled">
        <View className="mb-8 items-center">
          <KortixLogo variant="text" size={24} color={scheme} />
        </View>

        {claimError ? (
          <View className="mb-4 rounded-2xl border border-border bg-card px-4 py-3">
            <Text variant="small" className="text-foreground">
              {claimError}
            </Text>
          </View>
        ) : null}

        <DaytonaStepView
          mode={forcedReconnect || status?.reconnectRequired ? 'reconnect' : 'post-auth'}
          onComplete={({ status: nextStatus }) => {
            setClaimError(null);
            setForcedReconnect(false);
            if (nextStatus) {
              queryClient.setQueryData(DAYTONA_STATUS_QUERY_KEY, nextStatus);
            }
            void queryClient.invalidateQueries({ queryKey: DAYTONA_STATUS_QUERY_KEY });
          }}
        />

        <View className="mt-6 items-center">
          <Button
            variant="ghost"
            size="default"
            className="rounded-full"
            disabled={signingOut}
            onPress={signOutAndRoute}>
            <Text>{copy.signOut}</Text>
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
