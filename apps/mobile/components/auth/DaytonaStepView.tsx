/**
 * Per-user Daytona Cloud Computer onboarding view (Mobile).
 *
 * Matches Kortix's minimalist monochrome design system:
 * - Crisp 2-step stepper (`Step 1: Connect Daytona` -> `Step 2: Sign in`)
 * - Clear 3-point "Why Daytona?" card (isolated workspace, free credits, 1-time setup)
 * - Uses `WebBrowser.openBrowserAsync` (Chrome Custom Tabs on Android / Safari
 *   View Controller on iOS — never a WebView)
 * - Persists active `flowId` across Android activity restarts
 * - Zero emojis, zero raw JSON, full Light/Dark mode + English & Arabic copy
 */

import * as React from 'react';
import { AppState, Pressable, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useColorScheme } from 'nativewind';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PlatformFullWidthButton } from '@/components/kortix/platform-button';
import { useLanguage } from '@/contexts';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckIcon,
  CpuIcon,
  KeyIcon,
  ShieldCheckIcon,
  SparkleIcon,
} from '@/lib/icons';
import {
  type DaytonaOnboardingStatus,
  type StartDaytonaConnectResponse,
  claimDaytonaConnect,
  clearActiveDaytonaFlow,
  clearAllPendingDaytonaState,
  clearPendingDaytonaClaim,
  clearPendingManualDaytonaKey,
  pollDaytonaConnect,
  readActiveDaytonaFlow,
  sanitizeUiErrorMessage,
  saveManualDaytonaKey,
  startDaytonaConnect,
  stashActiveDaytonaFlow,
  stashPendingDaytonaClaim,
  stashPendingManualDaytonaKey,
} from '@/lib/onboarding/daytona-client';
import { haptics } from '@/lib/haptics';
import { IN_APP_BROWSER_OPTIONS } from '@/lib/utils/link-target';
import { THEME, withAlpha } from '@/lib/utils/theme';

export interface MobileOnboardingCopy {
  step1Label: string;
  step2Label: string;
  connectTitle: string;
  connectSubtitle: string;
  reconnectTitle: string;
  reconnectSubtitle: string;
  continueWithDaytona: string;
  openingDaytona: string;
  linkingDaytona: string;
  newCodeCta: string;
  openDaytona: string;
  newCodeShort: string;
  confirmationCode: string;
  waiting: string;
  approveHint: string;
  whyItems: Array<{ title: string; body: string }>;
  manualToggle: string;
  manualSubmitPre: string;
  manualSubmitPost: string;
  manualValidating: string;
  manualInvalid: string;
  alreadyConnected: string;
  cancel: string;
  expiredError: string;
  genericError: string;
  emailVerifyHint: string;
  emailVerifyContinue: string;
}

const EN_MOBILE_COPY: MobileOnboardingCopy = {
  step1Label: 'Connect Daytona',
  step2Label: 'Sign in',
  connectTitle: 'Connect your private cloud computer',
  connectSubtitle:
    'One-time setup before signing in. Kortix runs your agent inside your own isolated Daytona workspace.',
  reconnectTitle: 'Reconnect your Daytona workspace',
  reconnectSubtitle:
    'Authorize Daytona once to refresh your region and workspace key. Your Kortix chats and projects stay intact.',
  continueWithDaytona: 'Continue with Daytona',
  openingDaytona: 'Opening Daytona…',
  linkingDaytona: 'Linking workspace…',
  newCodeCta: 'Generate new code',
  openDaytona: 'Open Daytona',
  newCodeShort: 'New code',
  confirmationCode: 'Confirmation code',
  waiting: 'Waiting…',
  approveHint: 'Approve the request in Daytona, then close the browser tab to continue automatically.',
  whyItems: [
    {
      title: 'Your own private cloud computer',
      body: 'Each account runs in its own isolated Linux and browser workspace instead of a shared server.',
    },
    {
      title: 'Free personal compute included',
      body: 'New Daytona accounts include free compute credits with no credit card required.',
    },
    {
      title: 'Automatic one-time setup',
      body: 'Sign in with Google or GitHub once. Kortix sets your region, key, and workspace in ~1 minute.',
    },
  ],
  manualToggle: 'Advanced: Paste Daytona API key',
  manualSubmitPre: 'Use API key and continue',
  manualSubmitPost: 'Save API key',
  manualValidating: 'Validating…',
  manualInvalid: 'Enter a valid Daytona API key starting with dtn_.',
  alreadyConnected: 'Already connected? Sign in to Kortix',
  cancel: 'Cancel',
  expiredError: 'The Daytona confirmation code expired. Tap below to generate a new code.',
  genericError: 'Could not reach Daytona right now. Please try again.',
  emailVerifyHint: 'Confirm your email address in Daytona, then return here to continue.',
  emailVerifyContinue: "I've verified my email — Continue",
};

const AR_MOBILE_COPY: MobileOnboardingCopy = {
  step1Label: 'ربط Daytona',
  step2Label: 'تسجيل الدخول',
  connectTitle: 'اربط حاسوبك السحابي الخاص',
  connectSubtitle:
    'إعداد لمرة واحدة قبل تسجيل الدخول. يشغّل Kortix وكيلك داخل مساحة عمل Daytona معزولة خاصة بك.',
  reconnectTitle: 'إعادة ربط مساحة عمل Daytona',
  reconnectSubtitle:
    'أعد التفويض مع Daytona لتحديث المنطقة ومفتاح مساحة العمل. محادثاتك ومشاريعك تبقى محفوظة.',
  continueWithDaytona: 'المتابعة باستخدام Daytona',
  openingDaytona: 'جارٍ فتح Daytona…',
  linkingDaytona: 'جارٍ ربط مساحة العمل…',
  newCodeCta: 'إنشاء رمز جديد',
  openDaytona: 'فتح Daytona',
  newCodeShort: 'رمز جديد',
  confirmationCode: 'رمز التأكيد',
  waiting: 'بانتظار الموافقة…',
  approveHint: 'وافق على الطلب في Daytona ثم أغلق المتصفح للمتابعة تلقائياً.',
  whyItems: [
    {
      title: 'حاسوبك السحابي الخاص بالكامل',
      body: 'كل حساب يعمل داخل بيئة Linux ومتصفح معزولة خاصة به بدلاً من خادم مشترك مزدحم.',
    },
    {
      title: 'رصيد حوسبة شخصي مجاني',
      body: 'تتضمن حسابات Daytona الجديدة رصيد حوسبة مجانياً بدون بطاقة ائتمان.',
    },
    {
      title: 'إعداد تلقائي لمرة واحدة',
      body: 'سجّل الدخول عبر Google أو GitHub مرة واحدة، وسيقوم Kortix بضبط المنطقة والمفتاح تلقائياً خلال دقيقة.',
    },
  ],
  manualToggle: 'متقدم: لصق مفتاح Daytona API يدوياً',
  manualSubmitPre: 'استخدام المفتاح والمتابعة',
  manualSubmitPost: 'حفظ مفتاح API',
  manualValidating: 'جارٍ التحقق…',
  manualInvalid: 'أدخل مفتاح Daytona API صالحاً يبدأ بـ dtn_.',
  alreadyConnected: 'مرتبط بالفعل؟ سجّل الدخول إلى Kortix',
  cancel: 'إلغاء',
  expiredError: 'انتهت صلاحية رمز التأكيد. اضغط أدناه لإنشاء رمز جديد.',
  genericError: 'تعذّر الاتصال بـ Daytona الآن. يرجى المحاولة مرة أخرى.',
  emailVerifyHint: 'أكّد بريدك الإلكتروني في Daytona ثم عد إلى هنا للمتابعة.',
  emailVerifyContinue: 'أكّدت بريدي الإلكتروني — متابعة',
};

export function useMobileOnboardingLocale() {
  const { currentLanguage } = useLanguage();
  const isAr = currentLanguage?.toLowerCase().startsWith('ar') ?? false;
  return { isAr, copy: isAr ? AR_MOBILE_COPY : EN_MOBILE_COPY };
}

/**
 * Crisp 2-step monochrome stepper for Mobile onboarding.
 */
export function MobileOnboardingStepper({
  activeStep,
  step1Complete = false,
}: {
  activeStep: 1 | 2;
  step1Complete?: boolean;
}) {
  const { copy, isAr } = useMobileOnboardingLocale();
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const colors = THEME[scheme];

  return (
    <View
      className="mb-1 flex-row items-center gap-2.5"
      style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
      <View
        className="flex-row items-center gap-2"
        style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
        <View
          className="size-5 items-center justify-center rounded-full border border-border"
          style={{
            backgroundColor: step1Complete
              ? colors.card
              : activeStep === 1
                ? colors.foreground
                : colors.muted,
          }}>
          {step1Complete ? (
            <Icon as={CheckIcon} size={12} color={colors.foreground} />
          ) : (
            <Text
              className="text-[11px] font-roobert-semibold"
              style={{
                color: activeStep === 1 ? colors.background : colors.mutedForeground,
              }}>
              1
            </Text>
          )}
        </View>
        <Text
          variant="small"
          className={
            activeStep === 1 || step1Complete
              ? 'font-roobert-medium text-foreground'
              : 'text-muted-foreground'
          }>
          {copy.step1Label}
        </Text>
      </View>

      <View className="h-px flex-1 bg-border" />

      <View
        className="flex-row items-center gap-2"
        style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
        <View
          className="size-5 items-center justify-center rounded-full"
          style={{
            backgroundColor: activeStep === 2 ? colors.foreground : colors.muted,
          }}>
          <Text
            className="text-[11px] font-roobert-semibold"
            style={{
              color: activeStep === 2 ? colors.background : colors.mutedForeground,
            }}>
            2
          </Text>
        </View>
        <Text
          variant="small"
          className={
            activeStep === 2 ? 'font-roobert-medium text-foreground' : 'text-muted-foreground'
          }>
          {copy.step2Label}
        </Text>
      </View>
    </View>
  );
}

export interface DaytonaStepCompletePayload {
  method: 'device' | 'manual';
  orgId?: string;
  region?: string;
  status?: DaytonaOnboardingStatus;
}

export interface DaytonaStepViewProps {
  mode: 'pre-auth' | 'post-auth' | 'reconnect';
  onComplete: (payload: DaytonaStepCompletePayload) => void;
  /** Pre-auth only: returning users who already bound Daytona can skip straight to Step 2. */
  onSkipToSignIn?: () => void;
  /** Optional cancel button (e.g. inside Settings sheet). */
  onCancel?: () => void;
}

export function DaytonaStepView({
  mode,
  onComplete,
  onSkipToSignIn,
  onCancel,
}: DaytonaStepViewProps) {
  const { copy, isAr } = useMobileOnboardingLocale();
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const colors = THEME[scheme];

  const [flow, setFlow] = React.useState<StartDaytonaConnectResponse | null>(null);
  const [phase, setPhase] = React.useState<'idle' | 'starting' | 'polling' | 'claiming' | 'expired'>('idle');
  const [infoMessage, setInfoMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [awaitingEmailVerify, setAwaitingEmailVerify] = React.useState(false);

  const [showManual, setShowManual] = React.useState(false);
  const [manualKey, setManualKey] = React.useState('');
  const [manualSaving, setManualSaving] = React.useState(false);

  const pollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalMsRef = React.useRef<number>(5_000);
  const activeFlowIdRef = React.useRef<string | null>(null);
  const pollInFlightRef = React.useRef(false);

  const stopPolling = React.useCallback(() => {
    activeFlowIdRef.current = null;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => stopPolling, [stopPolling]);

  const runPollOnce = React.useCallback(
    async (flowId: string) => {
      if (activeFlowIdRef.current !== flowId || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const result = await pollDaytonaConnect(flowId);
        if (activeFlowIdRef.current !== flowId) return;

        if (result.status === 'pending') {
          if (result.slowDown) {
            pollIntervalMsRef.current = Math.min(pollIntervalMsRef.current + 3_000, 15_000);
          }
          pollTimerRef.current = setTimeout(() => {
            void runPollOnce(flowId);
          }, pollIntervalMsRef.current);
          return;
        }

        if (result.status === 'expired') {
          stopPolling();
          await clearActiveDaytonaFlow();
          setPhase('expired');
          setErrorMessage(copy.expiredError);
          return;
        }

        if (result.status === 'email_verification_required') {
          setAwaitingEmailVerify(true);
          setInfoMessage(sanitizeUiErrorMessage(result.message, copy.emailVerifyHint));
          pollTimerRef.current = setTimeout(() => {
            void runPollOnce(flowId);
          }, Math.max(pollIntervalMsRef.current, 6_000));
          return;
        }

        if (result.status === 'approved') {
          setAwaitingEmailVerify(false);
          stopPolling();
          await clearActiveDaytonaFlow();
          haptics.success();

          if (mode === 'pre-auth') {
            await stashPendingDaytonaClaim(result.claimToken, {
              orgId: result.orgId,
              region: result.region,
            });
            clearPendingManualDaytonaKey();
            onComplete({
              method: 'device',
              orgId: result.orgId,
              region: result.region,
            });
            return;
          }

          setPhase('claiming');
          setInfoMessage(copy.linkingDaytona);
          const status = await claimDaytonaConnect(result.claimToken);
          await clearPendingDaytonaClaim();
          onComplete({
            method: 'device',
            orgId: status.orgId ?? result.orgId,
            region: status.region ?? result.region,
            status,
          });
          return;
        }

        if (result.status === 'claimed') {
          stopPolling();
          await clearActiveDaytonaFlow();
          onComplete({
            method: 'device',
            orgId: result.orgId ?? undefined,
            region: result.region ?? undefined,
          });
        }
      } catch (err) {
        if (activeFlowIdRef.current !== flowId) return;
        const msg = sanitizeUiErrorMessage(
          err instanceof Error ? err.message : null,
          copy.genericError,
        );
        setErrorMessage(msg);
        pollTimerRef.current = setTimeout(() => {
          void runPollOnce(flowId);
        }, Math.max(pollIntervalMsRef.current, 6_000));
      } finally {
        pollInFlightRef.current = false;
      }
    },
    [copy, mode, onComplete, stopPolling],
  );

  // Resume active Device Flow if Android restarted the activity while user was in Chrome Custom Tabs.
  React.useEffect(() => {
    let mounted = true;
    void readActiveDaytonaFlow().then((saved) => {
      if (!mounted || !saved) return;
      setFlow(saved);
      setPhase('polling');
      pollIntervalMsRef.current = Math.max((saved.interval || 5) * 1000, 4_000);
      activeFlowIdRef.current = saved.flowId;
      void runPollOnce(saved.flowId);
    });
    return () => {
      mounted = false;
    };
  }, [runPollOnce]);

  // Poll immediately when returning from Chrome Custom Tabs / Safari View Controller.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && activeFlowIdRef.current) {
        if (pollTimerRef.current) {
          clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        void runPollOnce(activeFlowIdRef.current);
      }
    });
    return () => sub.remove();
  }, [runPollOnce]);

  const openVerificationTab = React.useCallback(async (url: string) => {
    await WebBrowser.openBrowserAsync(url, {
      ...IN_APP_BROWSER_OPTIONS,
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    }).catch(() => {});
  }, []);

  const handleStartDaytona = async () => {
    haptics.tap();
    stopPolling();
    await clearActiveDaytonaFlow();
    setErrorMessage(null);
    setInfoMessage(null);
    setPhase('starting');

    try {
      const started = await startDaytonaConnect();
      await stashActiveDaytonaFlow(started);
      setFlow(started);
      setPhase('polling');
      pollIntervalMsRef.current = Math.max((started.interval || 5) * 1000, 4_000);
      activeFlowIdRef.current = started.flowId;

      pollTimerRef.current = setTimeout(() => {
        void runPollOnce(started.flowId);
      }, pollIntervalMsRef.current);

      await openVerificationTab(started.verificationUriComplete);
      if (activeFlowIdRef.current === started.flowId) {
        if (pollTimerRef.current) {
          clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        void runPollOnce(started.flowId);
      }
    } catch (err) {
      setPhase('idle');
      setErrorMessage(
        sanitizeUiErrorMessage(err instanceof Error ? err.message : null, copy.genericError),
      );
    }
  };

  const handleManualSubmit = async () => {
    const trimmed = manualKey.trim();
    if (!trimmed.startsWith('dtn_') || trimmed.length < 16) {
      setErrorMessage(copy.manualInvalid);
      return;
    }

    haptics.tap();
    setErrorMessage(null);
    setInfoMessage(null);

    if (mode === 'pre-auth') {
      stopPolling();
      await clearActiveDaytonaFlow();
      await clearPendingDaytonaClaim();
      stashPendingManualDaytonaKey(trimmed);
      haptics.success();
      onComplete({ method: 'manual' });
      return;
    }

    setManualSaving(true);
    try {
      stopPolling();
      const status = await saveManualDaytonaKey(trimmed);
      await clearAllPendingDaytonaState();
      haptics.success();
      onComplete({
        method: 'manual',
        orgId: status.orgId ?? undefined,
        region: status.region ?? undefined,
        status,
      });
    } catch (err) {
      setErrorMessage(
        sanitizeUiErrorMessage(err instanceof Error ? err.message : null, copy.genericError),
      );
    } finally {
      setManualSaving(false);
    }
  };

  const title = mode === 'reconnect' ? copy.reconnectTitle : copy.connectTitle;
  const description = mode === 'reconnect' ? copy.reconnectSubtitle : copy.connectSubtitle;
  const busy = phase === 'starting' || phase === 'claiming' || manualSaving;
  const whyIcons = [CpuIcon, SparkleIcon, ShieldCheckIcon] as const;

  return (
    <View className="w-full gap-5">
      {mode === 'pre-auth' ? <MobileOnboardingStepper activeStep={1} /> : null}

      <View className="gap-2">
        <Text
          variant="h3"
          className="font-roobert-semibold text-foreground"
          style={{ textAlign: isAr ? 'right' : 'left' }}>
          {title}
        </Text>
        <Text
          variant="muted"
          className="leading-5"
          style={{ textAlign: isAr ? 'right' : 'left' }}>
          {description}
        </Text>
      </View>

      {mode !== 'reconnect' ? (
        <View className="overflow-hidden rounded-2xl border border-border bg-card">
          {copy.whyItems.map((item, idx) => {
            const RowIcon = whyIcons[idx] ?? CpuIcon;
            return (
              <View
                key={item.title}
                className={idx > 0 ? 'border-t border-border px-4 py-3.5' : 'px-4 py-3.5'}
                style={{
                  flexDirection: isAr ? 'row-reverse' : 'row',
                  alignItems: 'flex-start',
                  gap: 12,
                }}>
                <View className="mt-0.5 size-7 items-center justify-center rounded-lg border border-border bg-background">
                  <Icon as={RowIcon} size={14} className="text-foreground" />
                </View>
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text
                    variant="small"
                    className="font-roobert-medium text-foreground"
                    style={{ textAlign: isAr ? 'right' : 'left' }}>
                    {item.title}
                  </Text>
                  <Text
                    variant="small"
                    className="leading-4 text-muted-foreground"
                    style={{ textAlign: isAr ? 'right' : 'left' }}>
                    {item.body}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {infoMessage ? (
        <View className="rounded-2xl border border-border bg-card px-4 py-3">
          <Text variant="small" className="text-foreground" style={{ textAlign: isAr ? 'right' : 'left' }}>
            {infoMessage}
          </Text>
        </View>
      ) : null}

      {errorMessage ? (
        <View
          className="rounded-2xl px-4 py-3"
          style={{ backgroundColor: withAlpha(colors.destructive, 0.14) }}>
          <Text
            variant="small"
            className="text-destructive"
            style={{ textAlign: isAr ? 'right' : 'left' }}>
            {errorMessage}
          </Text>
        </View>
      ) : null}

      {phase === 'polling' && flow ? (
        <View className="gap-3.5 rounded-2xl border border-border bg-card p-4">
          <View
            className="flex-row items-center justify-between"
            style={{ flexDirection: isAr ? 'row-reverse' : 'row' }}>
            <View className="gap-0.5">
              <Text variant="small" className="text-muted-foreground">
                {copy.confirmationCode}
              </Text>
              <Text className="font-mono text-xl font-semibold tracking-widest text-foreground">
                {flow.userCode}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <KortixLoader size="small" />
              <Text variant="small" className="text-muted-foreground">
                {copy.waiting}
              </Text>
            </View>
          </View>
          <Text
            variant="small"
            className="leading-5 text-muted-foreground"
            style={{ textAlign: isAr ? 'right' : 'left' }}>
            {copy.approveHint}
          </Text>
          {awaitingEmailVerify ? (
            <Button
              variant="default"
              size="default"
              className="rounded-full"
              onPress={() => {
                haptics.tap();
                setErrorMessage(null);
                if (pollTimerRef.current) {
                  clearTimeout(pollTimerRef.current);
                  pollTimerRef.current = null;
                }
                void runPollOnce(flow.flowId);
              }}>
              <Icon as={CheckIcon} size={16} color={colors.primaryForeground} />
              <Text>{copy.emailVerifyContinue}</Text>
            </Button>
          ) : null}
          <View className="flex-row gap-2">
            <Button
              variant="outline"
              size="default"
              className="flex-1 rounded-full"
              onPress={() => void openVerificationTab(flow.verificationUriComplete)}>
              <Icon as={ArrowSquareOutIcon} size={16} className="text-foreground" />
              <Text>{copy.openDaytona}</Text>
            </Button>
            <Button
              variant="secondary"
              size="default"
              className="rounded-full"
              onPress={() => void handleStartDaytona()}>
              <Icon as={ArrowClockwiseIcon} size={16} className="text-foreground" />
              <Text>{copy.newCodeShort}</Text>
            </Button>
          </View>
        </View>
      ) : (
        <PlatformFullWidthButton
          size="xl"
          label={
            phase === 'starting'
              ? copy.openingDaytona
              : phase === 'claiming'
                ? copy.linkingDaytona
                : phase === 'expired'
                  ? copy.newCodeCta
                  : copy.continueWithDaytona
          }
          leading={<Icon as={ArrowSquareOutIcon} size={18} color={colors.primaryForeground} />}
          disabled={busy}
          onPress={() => void handleStartDaytona()}
        />
      )}

      {/* Collapsible manual API key fallback */}
      <View className="border-t border-border pt-3">
        <Pressable
          onPress={() => {
            haptics.tap();
            setErrorMessage(null);
            setShowManual((v) => !v);
          }}
          accessibilityRole="button"
          className="flex-row items-center justify-between py-1.5"
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
          <View className="mt-3 gap-3">
            <TextInput
              value={manualKey}
              onChangeText={(text) => {
                setErrorMessage(null);
                setManualKey(text);
              }}
              placeholder="dtn_..."
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!manualSaving}
              returnKeyType="done"
              onSubmitEditing={() => void handleManualSubmit()}
              className="rounded-xl border border-border bg-card px-3.5 py-3 text-foreground"
              style={{ color: colors.foreground }}
            />
            <Button
              size="lg"
              variant="secondary"
              className="rounded-full"
              disabled={manualSaving || manualKey.trim().length < 16}
              onPress={() => void handleManualSubmit()}>
              <Text>
                {manualSaving
                  ? copy.manualValidating
                  : mode === 'pre-auth'
                    ? copy.manualSubmitPre
                    : copy.manualSubmitPost}
              </Text>
            </Button>
          </View>
        ) : null}
      </View>

      {mode === 'pre-auth' && onSkipToSignIn ? (
        <Pressable
          onPress={() => {
            haptics.tap();
            onSkipToSignIn();
          }}
          disabled={busy}
          accessibilityRole="button"
          className="items-center py-2 active:opacity-70">
          <Text variant="small" className="text-muted-foreground underline">
            {copy.alreadyConnected}
          </Text>
        </Pressable>
      ) : null}

      {onCancel ? (
        <Button variant="ghost" size="lg" className="rounded-full" disabled={busy} onPress={onCancel}>
          <Text>{copy.cancel}</Text>
        </Button>
      ) : null}
    </View>
  );
}
