'use client';

/**
 * Per-user Daytona Cloud Computer onboarding, setup progress, and error recovery UI (Web).
 *
 * Strictly adheres to Kortix's minimalist monochrome design system:
 * - Semantic tokens only (`bg-background`, `bg-card`, `border-border`, `text-foreground`,
 *   `text-muted-foreground`, `text-destructive`, `--kortix-green`).
 * - Zero emojis and zero raw JSON error strings.
 * - Full Light/Dark mode + English & Arabic (`ar`) RTL copy.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  CheckIcon,
  CpuIcon,
  KeyIcon,
  ShieldCheckIcon,
  SparkleIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { KortixLogo } from '@kortix/ui/kortix-logo';
import Loading from '@kortix/ui/loading';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import {
  FieldError,
  FieldLabel,
  InfoStrip,
  QuietLinks,
  StepHeader,
} from '@kortix/ui/internal/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { useLocale } from '@/i18n/use-translations';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import {
  DAYTONA_RECONNECT_EVENT,
  DAYTONA_STATUS_QUERY_KEY,
  type DaytonaOnboardingErrorCode,
  type DaytonaOnboardingStatus,
  type StartDaytonaConnectResponse,
  claimDaytonaConnect,
  clearActiveDaytonaFlow,
  clearAllPendingDaytonaState,
  clearPendingDaytonaClaim,
  clearPendingManualDaytonaKey,
  fetchDaytonaOnboardingStatus,
  inferDaytonaErrorCode,
  pollDaytonaConnect,
  readActiveDaytonaFlow,
  readPendingDaytonaClaim,
  readPendingManualDaytonaKey,
  sanitizeUiErrorMessage,
  saveManualDaytonaKey,
  startDaytonaConnect,
  stashActiveDaytonaFlow,
  stashPendingDaytonaClaim,
  stashPendingManualDaytonaKey,
} from '@/lib/onboarding/daytona-client';

interface OnboardingCopy {
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
  openDaytonaAgain: string;
  newCodeShort: string;
  confirmationCode: string;
  waitingApproval: string;
  approveHint: string;
  whyItems: Array<{ title: string; body: string }>;
  manualToggle: string;
  manualLabel: string;
  manualSubmitPre: string;
  manualSubmitPost: string;
  manualInvalid: string;
  alreadyConnected: string;
  cancel: string;
  step1Done: string;
  change: string;
  setupTitle: string;
  setupSubtitle: string;
  stageRegion: string;
  stageImagePull: string;
  stageImageActivate: string;
  stageReady: string;
  oneTimeHint: string;
  checkNow: string;
  signOut: string;
  retrySetup: string;
  reconnectCta: string;
  checking: string;
  connecting: string;
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
  expiredError: string;
}

const EN_COPY: OnboardingCopy = {
  step1Label: 'Connect Daytona',
  step2Label: 'Sign in to Kortix',
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
  openDaytonaAgain: 'Open Daytona again',
  newCodeShort: 'New code',
  confirmationCode: 'Confirmation code',
  waitingApproval: 'Waiting for approval…',
  approveHint: 'Approve the request in the Daytona tab. This screen advances automatically.',
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
      body: 'Sign in with Google or GitHub once. Kortix configures your region, key, and workspace in ~1 minute.',
    },
  ],
  manualToggle: 'Advanced: Paste Daytona API key',
  manualLabel: 'Daytona API key',
  manualSubmitPre: 'Use API key and continue',
  manualSubmitPost: 'Save API key',
  manualInvalid: 'Enter a valid Daytona API key starting with dtn_.',
  alreadyConnected: 'Already connected? Sign in to Kortix',
  cancel: 'Cancel',
  step1Done: 'Step 1 complete · Daytona connected',
  change: 'Change',
  setupTitle: 'Preparing your private cloud computer',
  setupSubtitle: 'One-time workspace setup. This usually completes in under a minute.',
  stageRegion: 'Workspace region configured',
  stageImagePull: 'Downloading cloud computer image',
  stageImageActivate: 'Activating cloud computer image',
  stageReady: 'Ready to launch',
  oneTimeHint: 'You will only see this screen once per Daytona workspace.',
  checkNow: 'Check status',
  signOut: 'Sign out',
  retrySetup: 'Retry setup',
  reconnectCta: 'Reconnect Daytona',
  checking: 'Checking your cloud computer…',
  connecting: 'Connecting your Daytona workspace…',
  errorTitleRegion: 'Workspace region required',
  errorBodyRegion:
    'Your Daytona workspace does not have a default region selected yet. Reconnect Daytona and Kortix will configure it automatically.',
  errorTitleReconnect: 'Reconnect your Daytona workspace',
  errorBodyReconnect:
    'Your Daytona connection expired or was revoked. Reconnect Daytona to resume your cloud computer.',
  errorTitleEmail: 'Verify your Daytona email',
  errorBodyEmail: 'Confirm your email address in Daytona, then retry setup to finish.',
  errorTitleQuota: 'Workspace limit reached',
  errorBodyQuota:
    'Your Daytona workspace reached its free compute or storage limit. Free up space in Daytona, then retry.',
  errorTitleGeneric: 'Cloud computer setup paused',
  errorBodyGeneric:
    'We could not finish preparing your cloud computer right now. Retry setup or reconnect Daytona.',
  expiredError: 'The Daytona confirmation code expired. Generate a new code to continue.',
};

const AR_COPY: OnboardingCopy = {
  step1Label: 'ربط Daytona',
  step2Label: 'تسجيل الدخول إلى Kortix',
  connectTitle: 'اربط حاسوبك السحابي الخاص',
  connectSubtitle:
    'إعداد لمرة واحدة قبل تسجيل الدخول. يشغّل Kortix وكيلك داخل مساحة عمل Daytona معزولة خاصة بك.',
  reconnectTitle: 'إعادة ربط مساحة عمل Daytona',
  reconnectSubtitle:
    'أعد التفويض مع Daytona لتحديث المنطقة ومفتاح مساحة العمل. محادثاتك ومشاريعك في Kortix تبقى محفوظة.',
  continueWithDaytona: 'المتابعة باستخدام Daytona',
  openingDaytona: 'جارٍ فتح Daytona…',
  linkingDaytona: 'جارٍ ربط مساحة العمل…',
  newCodeCta: 'إنشاء رمز جديد',
  openDaytonaAgain: 'فتح Daytona مجدداً',
  newCodeShort: 'رمز جديد',
  confirmationCode: 'رمز التأكيد',
  waitingApproval: 'بانتظار الموافقة…',
  approveHint: 'وافق على الطلب في صفحة Daytona. ستنتقل هذه الصفحة تلقائياً فور التأكيد.',
  whyItems: [
    {
      title: 'حاسوبك السحابي الخاص بالكامل',
      body: 'كل حساب يعمل داخل بيئة Linux ومتصفح معزولة خاصة به بدلاً من خادم مشترك مزدحم.',
    },
    {
      title: 'رصيد حوسبة شخصي مجاني',
      body: 'تتضمن حسابات Daytona الجديدة رصيد حوسبة مجانياً بدون الحاجة إلى بطاقة ائتمان.',
    },
    {
      title: 'إعداد تلقائي لمرة واحدة',
      body: 'سجّل الدخول عبر Google أو GitHub مرة واحدة، وسيقوم Kortix بضبط المنطقة والمفتاح وبيئة العمل تلقائياً خلال دقيقة.',
    },
  ],
  manualToggle: 'متقدم: لصق مفتاح Daytona API يدوياً',
  manualLabel: 'مفتاح Daytona API',
  manualSubmitPre: 'استخدام المفتاح والمتابعة',
  manualSubmitPost: 'حفظ مفتاح API',
  manualInvalid: 'أدخل مفتاح Daytona API صالحاً يبدأ بـ dtn_.',
  alreadyConnected: 'مرتبط بالفعل؟ سجّل الدخول إلى Kortix',
  cancel: 'إلغاء',
  step1Done: 'اكتملت الخطوة 1 · تم ربط Daytona',
  change: 'تغيير',
  setupTitle: 'جارٍ تجهيز حاسوبك السحابي الخاص',
  setupSubtitle: 'إعداد لمرة واحدة لمساحة العمل. يستغرق عادة أقل من دقيقة.',
  stageRegion: 'تم ضبط منطقة مساحة العمل',
  stageImagePull: 'جارٍ تنزيل صورة الحاسوب السحابي',
  stageImageActivate: 'جارٍ تفعيل صورة الحاسوب السحابي',
  stageReady: 'جاهز للبدء',
  oneTimeHint: 'ستظهر هذه الشاشة مرة واحدة فقط لكل مساحة عمل Daytona.',
  checkNow: 'تحديث الحالة',
  signOut: 'تسجيل الخروج',
  retrySetup: 'إعادة المحاولة',
  reconnectCta: 'إعادة ربط Daytona',
  checking: 'جارٍ التحقق من حاسوبك السحابي…',
  connecting: 'جارٍ ربط مساحة عمل Daytona…',
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
  expiredError: 'انتهت صلاحية رمز التأكيد. أنشئ رمزاً جديداً للمتابعة.',
};

function useOnboardingCopy(): { copy: OnboardingCopy; isRtl: boolean } {
  const locale = useLocale();
  const isRtl = locale.toLowerCase().startsWith('ar');
  return { copy: isRtl ? AR_COPY : EN_COPY, isRtl };
}

function resolveErrorPresentation(
  code: DaytonaOnboardingErrorCode,
  copy: OnboardingCopy,
): { title: string; body: string; preferReconnect: boolean } {
  switch (code) {
    case 'DAYTONA_REGION_REQUIRED':
      return {
        title: copy.errorTitleRegion,
        body: copy.errorBodyRegion,
        preferReconnect: true,
      };
    case 'DAYTONA_RECONNECT_REQUIRED':
      return {
        title: copy.errorTitleReconnect,
        body: copy.errorBodyReconnect,
        preferReconnect: true,
      };
    case 'DAYTONA_EMAIL_UNVERIFIED':
      return {
        title: copy.errorTitleEmail,
        body: copy.errorBodyEmail,
        preferReconnect: false,
      };
    case 'DAYTONA_QUOTA_EXCEEDED':
      return {
        title: copy.errorTitleQuota,
        body: copy.errorBodyQuota,
        preferReconnect: false,
      };
    default:
      return {
        title: copy.errorTitleGeneric,
        body: copy.errorBodyGeneric,
        preferReconnect: false,
      };
  }
}

/**
 * Crisp 2-step monochrome stepper shared by Step 1 and Step 2 on `/auth`.
 */
export function OnboardingStepper({
  activeStep,
  step1Complete = false,
}: {
  activeStep: 1 | 2;
  step1Complete?: boolean;
}) {
  const { copy, isRtl } = useOnboardingCopy();
  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="mb-5 flex items-center gap-2.5 text-xs"
      aria-label="Onboarding progress"
    >
      <div className="flex items-center gap-2">
        <span
          className={
            step1Complete
              ? 'bg-card border-border inline-flex size-5 items-center justify-center rounded-full border text-[var(--kortix-green)]'
              : activeStep === 1
                ? 'bg-foreground text-background inline-flex size-5 items-center justify-center rounded-full font-medium'
                : 'bg-muted text-muted-foreground inline-flex size-5 items-center justify-center rounded-full font-medium'
          }
        >
          {step1Complete ? <CheckIcon className="size-3" weight="bold" /> : '1'}
        </span>
        <span
          className={
            activeStep === 1 || step1Complete
              ? 'text-foreground font-medium'
              : 'text-muted-foreground'
          }
        >
          {copy.step1Label}
        </span>
      </div>
      <div className="bg-border h-px flex-1" aria-hidden />
      <div className="flex items-center gap-2">
        <span
          className={
            activeStep === 2
              ? 'bg-foreground text-background inline-flex size-5 items-center justify-center rounded-full font-medium'
              : 'bg-muted text-muted-foreground inline-flex size-5 items-center justify-center rounded-full font-medium'
          }
        >
          2
        </span>
        <span className={activeStep === 2 ? 'text-foreground font-medium' : 'text-muted-foreground'}>
          {copy.step2Label}
        </span>
      </div>
    </div>
  );
}

export interface DaytonaStepCompletePayload {
  method: 'device' | 'manual';
  orgId?: string;
  region?: string;
  status?: DaytonaOnboardingStatus;
}

export interface DaytonaStepCardProps {
  mode: 'pre-auth' | 'post-auth' | 'reconnect';
  onComplete: (payload: DaytonaStepCompletePayload) => void;
  /** Pre-auth only: returning users who already bound Daytona can jump straight to Step 2. */
  onSkipToSignIn?: () => void;
  /** Optional cancel callback (e.g. inside Settings Reconnect modal). */
  onCancel?: () => void;
}

export function DaytonaStepCard({
  mode,
  onComplete,
  onSkipToSignIn,
  onCancel,
}: DaytonaStepCardProps) {
  const { copy, isRtl } = useOnboardingCopy();
  const [flow, setFlow] = useState<StartDaytonaConnectResponse | null>(null);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'polling' | 'claiming' | 'expired'>('idle');
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [showManual, setShowManual] = useState(false);
  const [manualKey, setManualKey] = useState('');
  const [manualSaving, setManualSaving] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalMsRef = useRef<number>(5_000);
  const activeFlowIdRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    activeFlowIdRef.current = null;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const schedulePoll = useCallback(
    (flowId: string, delayMs: number) => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = setTimeout(async () => {
        if (activeFlowIdRef.current !== flowId) return;
        try {
          const result = await pollDaytonaConnect(flowId);
          if (activeFlowIdRef.current !== flowId) return;

          if (result.status === 'pending') {
            if (result.slowDown) {
              pollIntervalMsRef.current = Math.min(pollIntervalMsRef.current + 3_000, 15_000);
            }
            schedulePoll(flowId, pollIntervalMsRef.current);
            return;
          }

          if (result.status === 'expired') {
            stopPolling();
            clearActiveDaytonaFlow();
            setPhase('expired');
            setErrorMessage(copy.expiredError);
            return;
          }

          if (result.status === 'email_verification_required') {
            setInfoMessage(sanitizeUiErrorMessage(result.message, copy.errorBodyEmail));
            schedulePoll(flowId, Math.max(pollIntervalMsRef.current, 6_000));
            return;
          }

          if (result.status === 'approved') {
            stopPolling();
            clearActiveDaytonaFlow();
            if (mode === 'pre-auth') {
              stashPendingDaytonaClaim(result.claimToken, {
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
            setInfoMessage(copy.connecting);
            const status = await claimDaytonaConnect(result.claimToken);
            clearPendingDaytonaClaim();
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
            clearActiveDaytonaFlow();
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
            copy.errorBodyGeneric,
          );
          setErrorMessage(msg);
          schedulePoll(flowId, Math.max(pollIntervalMsRef.current, 6_000));
        }
      }, delayMs);
    },
    [copy, mode, onComplete, stopPolling],
  );

  // Resume an in-progress Device Flow if the browser reloaded while the user authorized Daytona.
  useEffect(() => {
    const saved = readActiveDaytonaFlow();
    if (!saved) return;
    setFlow(saved);
    setPhase('polling');
    pollIntervalMsRef.current = Math.max((saved.interval || 5) * 1000, 4_000);
    activeFlowIdRef.current = saved.flowId;
    schedulePoll(saved.flowId, 1_500);
  }, [schedulePoll]);

  const handleStartDaytona = async () => {
    stopPolling();
    clearActiveDaytonaFlow();
    setErrorMessage(null);
    setInfoMessage(null);
    setPhase('starting');

    const popup = typeof window !== 'undefined' ? window.open('', '_blank', 'noopener,noreferrer') : null;

    try {
      const started = await startDaytonaConnect();
      stashActiveDaytonaFlow(started);
      setFlow(started);
      setPhase('polling');
      pollIntervalMsRef.current = Math.max((started.interval || 5) * 1000, 4_000);
      activeFlowIdRef.current = started.flowId;

      if (popup && !popup.closed) {
        popup.location.href = started.verificationUriComplete;
      } else if (typeof window !== 'undefined') {
        window.open(started.verificationUriComplete, '_blank', 'noopener,noreferrer');
      }

      schedulePoll(started.flowId, pollIntervalMsRef.current);
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      setPhase('idle');
      setErrorMessage(
        sanitizeUiErrorMessage(
          err instanceof Error ? err.message : null,
          copy.errorBodyGeneric,
        ),
      );
    }
  };

  const handleManualSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = manualKey.trim();
    if (!trimmed.startsWith('dtn_') || trimmed.length < 16) {
      setErrorMessage(copy.manualInvalid);
      return;
    }

    setErrorMessage(null);
    setInfoMessage(null);

    if (mode === 'pre-auth') {
      stopPolling();
      clearActiveDaytonaFlow();
      clearPendingDaytonaClaim();
      stashPendingManualDaytonaKey(trimmed);
      onComplete({ method: 'manual' });
      return;
    }

    setManualSaving(true);
    try {
      stopPolling();
      const status = await saveManualDaytonaKey(trimmed);
      clearAllPendingDaytonaState();
      onComplete({
        method: 'manual',
        orgId: status.orgId ?? undefined,
        region: status.region ?? undefined,
        status,
      });
    } catch (err) {
      setErrorMessage(
        sanitizeUiErrorMessage(
          err instanceof Error ? err.message : null,
          copy.errorBodyGeneric,
        ),
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
    <div dir={isRtl ? 'rtl' : 'ltr'} className="space-y-5">
      {mode === 'pre-auth' ? <OnboardingStepper activeStep={1} /> : null}

      <StepHeader title={title} description={description} />

      {mode !== 'reconnect' ? (
        <div className="bg-card border-border divide-border divide-y rounded-xl border">
          {copy.whyItems.map((item, idx) => {
            const RowIcon = whyIcons[idx] ?? CpuIcon;
            return (
              <div key={item.title} className="flex items-start gap-3 px-3.5 py-3">
                <span className="bg-background border-border text-foreground mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg border">
                  <RowIcon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-foreground text-xs font-medium">{item.title}</p>
                  <p className="text-muted-foreground text-xs leading-relaxed">{item.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {infoMessage ? <InfoStrip message={infoMessage} /> : null}

      <div className="space-y-4">
        {phase === 'polling' && flow ? (
          <div className="bg-card border-border space-y-4 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <p className="text-muted-foreground text-xs font-medium">{copy.confirmationCode}</p>
                <p
                  dir="ltr"
                  className="text-foreground font-mono text-xl font-semibold tracking-widest"
                >
                  {flow.userCode}
                </p>
              </div>
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                <Loading className="size-3.5 shrink-0" />
                <span>{copy.waitingApproval}</span>
              </div>
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">{copy.approveHint}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  window.open(flow.verificationUriComplete, '_blank', 'noopener,noreferrer')
                }
              >
                <ArrowSquareOutIcon className="size-3.5 shrink-0" />
                {copy.openDaytonaAgain}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void handleStartDaytona()}>
                <ArrowClockwiseIcon className="size-3.5 shrink-0" />
                {copy.newCodeShort}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={() => void handleStartDaytona()}
          >
            {phase === 'starting' || phase === 'claiming' ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <ArrowSquareOutIcon className="size-4 shrink-0" />
            )}
            {phase === 'starting'
              ? copy.openingDaytona
              : phase === 'claiming'
                ? copy.linkingDaytona
                : phase === 'expired'
                  ? copy.newCodeCta
                  : copy.continueWithDaytona}
          </Button>
        )}

        {errorMessage ? <FieldError id="daytona-step-error" message={errorMessage} /> : null}

        {/* Collapsible manual API key fallback */}
        <div className="border-border border-t pt-3">
          <button
            type="button"
            onClick={() => {
              setErrorMessage(null);
              setShowManual((v) => !v);
            }}
            className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between py-1 text-start text-xs font-medium transition-colors"
          >
            <span className="inline-flex items-center gap-1.5">
              <KeyIcon className="size-3.5 shrink-0" />
              {copy.manualToggle}
            </span>
            {showManual ? (
              <CaretUpIcon className="size-3.5 shrink-0" />
            ) : (
              <CaretDownIcon className="size-3.5 shrink-0" />
            )}
          </button>

          {showManual ? (
            <form onSubmit={(e) => void handleManualSubmit(e)} className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <FieldLabel htmlFor="daytona-manual-api-key">{copy.manualLabel}</FieldLabel>
                <Input
                  id="daytona-manual-api-key"
                  type="password"
                  size="md"
                  placeholder="dtn_..."
                  dir="ltr"
                  value={manualKey}
                  onChange={(e) => {
                    setErrorMessage(null);
                    setManualKey(e.target.value);
                  }}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={manualSaving}
                />
              </div>
              <Button
                type="submit"
                variant="secondary"
                size="default"
                className="w-full"
                disabled={manualSaving || manualKey.trim().length < 16}
              >
                {manualSaving ? <Loading className="size-3.5 shrink-0" /> : null}
                {mode === 'pre-auth' ? copy.manualSubmitPre : copy.manualSubmitPost}
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      {mode === 'pre-auth' && onSkipToSignIn ? (
        <QuietLinks
          disabled={busy}
          links={[
            {
              key: 'already-connected',
              label: copy.alreadyConnected,
              onClick: onSkipToSignIn,
            },
          ]}
        />
      ) : null}

      {onCancel ? (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {copy.cancel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact Step 2 stepper + completion pill on `/auth` once Step 1 completed.
 */
export function DaytonaStepCompleteBanner({ onReset }: { onReset?: () => void }) {
  const { copy, isRtl } = useOnboardingCopy();
  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="mb-5 space-y-3">
      <OnboardingStepper activeStep={2} step1Complete />
      <div className="bg-card border-border flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
        <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
          <CheckCircleIcon className="size-4 shrink-0 text-[var(--kortix-green)]" weight="fill" />
          {copy.step1Done}
        </span>
        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            className="text-muted-foreground hover:text-foreground shrink-0 underline underline-offset-2 transition-colors"
          >
            {copy.change}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Authenticated shell gate (`apps/web/src/app/[locale]/(app)/layout.tsx`).
 */
export function DaytonaOnboardingGate({ children }: { children?: React.ReactNode }) {
  const { session, isLoading: authLoading } = useAuth();
  const { copy, isRtl } = useOnboardingCopy();
  const queryClient = useQueryClient();
  const [claimState, setClaimState] = useState<'idle' | 'claiming' | 'done'>('idle');
  const [claimError, setClaimError] = useState<string | null>(null);
  const [forcedReconnect, setForcedReconnect] = useState(false);
  const [showRecoveryManual, setShowRecoveryManual] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoverySaving, setRecoverySaving] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const claimAttemptedForUserRef = useRef<string | null>(null);

  const userId = session?.user?.id ?? null;

  useEffect(() => {
    const onReconnectRequired = () => {
      setForcedReconnect(true);
      void queryClient.invalidateQueries({ queryKey: DAYTONA_STATUS_QUERY_KEY });
    };
    window.addEventListener(DAYTONA_RECONNECT_EVENT, onReconnectRequired);
    return () => window.removeEventListener(DAYTONA_RECONNECT_EVENT, onReconnectRequired);
  }, [queryClient]);

  useEffect(() => {
    if (authLoading || !userId) return;
    if (claimAttemptedForUserRef.current === userId) return;
    claimAttemptedForUserRef.current = userId;

    const pendingClaim = readPendingDaytonaClaim();
    const pendingManualKey = readPendingManualDaytonaKey();
    if (!pendingClaim && !pendingManualKey) {
      setClaimState('done');
      return;
    }

    let cancelled = false;
    setClaimState('claiming');
    setClaimError(null);

    const run = async () => {
      try {
        let status: DaytonaOnboardingStatus;
        if (pendingClaim) {
          status = await claimDaytonaConnect(pendingClaim.claimToken);
        } else {
          status = await saveManualDaytonaKey(pendingManualKey!);
        }
        clearAllPendingDaytonaState();
        if (cancelled) return;
        queryClient.setQueryData(DAYTONA_STATUS_QUERY_KEY, status);
        setForcedReconnect(false);
      } catch (err) {
        clearAllPendingDaytonaState();
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
  }, [authLoading, copy.errorBodyReconnect, queryClient, userId]);

  const statusQuery = useQuery({
    queryKey: DAYTONA_STATUS_QUERY_KEY,
    queryFn: fetchDaytonaOnboardingStatus,
    enabled: !authLoading && !!session && claimState === 'done',
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

  if (authLoading || !session) {
    return <>{children}</>;
  }

  if (claimState !== 'done' || statusQuery.isPending) {
    return (
      <div dir={isRtl ? 'rtl' : 'ltr'} className="bg-background grid h-dvh place-items-center p-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Loading className="size-6" />
          <p className="text-muted-foreground text-sm">
            {claimState === 'claiming' ? copy.connecting : copy.checking}
          </p>
        </div>
      </div>
    );
  }

  if (statusQuery.isError && !statusQuery.data) {
    return (
      <div dir={isRtl ? 'rtl' : 'ltr'} className="bg-background grid h-dvh place-items-center p-6">
        <div className="bg-card border-border w-full max-w-md space-y-5 rounded-2xl border p-6">
          <div className="flex items-center gap-3">
            <span className="bg-destructive/10 text-destructive inline-flex size-9 shrink-0 items-center justify-center rounded-full">
              <WarningCircleIcon className="size-5" />
            </span>
            <KortixLogo variant="icon" size={20} className="text-foreground" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-foreground text-lg font-medium tracking-tight">
              {copy.errorTitleGeneric}
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {sanitizeUiErrorMessage(
                statusQuery.error instanceof Error ? statusQuery.error.message : null,
                copy.errorBodyGeneric,
              )}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button type="button" size="lg" className="w-full" onClick={() => void statusQuery.refetch()}>
              <ArrowClockwiseIcon className="size-4 shrink-0" />
              {copy.retrySetup}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => void performSignOut()}>
              {copy.signOut}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const status = statusQuery.data;

  // Returning user fast path: connected and snapshot active -> straight into the app.
  if (
    !forcedReconnect &&
    status?.connected &&
    !status.reconnectRequired &&
    status.snapshotStatus === 'active'
  ) {
    return <>{children}</>;
  }

  // First-time snapshot preparation screen with clear 3-stage vertical progress.
  if (
    !forcedReconnect &&
    status?.connected &&
    !status.reconnectRequired &&
    (status.snapshotStatus === 'pending' ||
      status.snapshotStatus === 'pulling' ||
      status.snapshotStatus === 'inactive')
  ) {
    const activeStageLabel =
      status.snapshotStatus === 'inactive' ? copy.stageImageActivate : copy.stageImagePull;
    return (
      <div dir={isRtl ? 'rtl' : 'ltr'} className="bg-background grid h-dvh place-items-center p-6">
        <div className="bg-card border-border w-full max-w-md space-y-6 rounded-2xl border p-6">
          <div className="flex items-center justify-between">
            <KortixLogo variant="icon" size={22} className="text-foreground" />
            <span className="bg-background border-border text-muted-foreground rounded-full border px-2.5 py-0.5 font-mono text-xs uppercase">
              {status.region || 'eu'}
            </span>
          </div>

          <div className="space-y-1.5">
            <h1 className="text-foreground text-lg font-medium tracking-tight">{copy.setupTitle}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">{copy.setupSubtitle}</p>
          </div>

          <ol className="bg-background border-border divide-border divide-y rounded-xl border text-xs">
            <li className="flex items-center gap-3 px-3.5 py-3">
              <CheckCircleIcon className="size-4 shrink-0 text-[var(--kortix-green)]" weight="fill" />
              <span className="text-foreground font-medium">{copy.stageRegion}</span>
            </li>
            <li className="flex items-center gap-3 px-3.5 py-3">
              <Loading className="size-4 shrink-0" />
              <span className="text-foreground font-medium">{activeStageLabel}</span>
            </li>
            <li className="flex items-center gap-3 px-3.5 py-3">
              <span className="border-border inline-flex size-4 shrink-0 rounded-full border" />
              <span className="text-muted-foreground">{copy.stageReady}</span>
            </li>
          </ol>

          <p className="text-muted-foreground text-xs">{copy.oneTimeHint}</p>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => void performSignOut()}>
              {copy.signOut}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void statusQuery.refetch()}>
              <ArrowClockwiseIcon className="size-3.5 shrink-0" />
              {copy.checkNow}
            </Button>
          </div>
        </div>
      </div>
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
    const presentation = resolveErrorPresentation(errCode, copy);

    const handleRecoveryManualSave = async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = recoveryKey.trim();
      if (!trimmed.startsWith('dtn_') || trimmed.length < 16) {
        setRecoveryError(copy.manualInvalid);
        return;
      }
      setRecoveryError(null);
      setRecoverySaving(true);
      try {
        const nextStatus = await saveManualDaytonaKey(trimmed);
        clearAllPendingDaytonaState();
        queryClient.setQueryData(DAYTONA_STATUS_QUERY_KEY, nextStatus);
        setShowRecoveryManual(false);
        setRecoveryKey('');
        void queryClient.invalidateQueries({ queryKey: DAYTONA_STATUS_QUERY_KEY });
      } catch (err) {
        setRecoveryError(
          sanitizeUiErrorMessage(
            err instanceof Error ? err.message : null,
            copy.errorBodyGeneric,
          ),
        );
      } finally {
        setRecoverySaving(false);
      }
    };

    return (
      <div dir={isRtl ? 'rtl' : 'ltr'} className="bg-background grid h-dvh place-items-center p-6">
        <div className="bg-card border-border w-full max-w-md space-y-5 rounded-2xl border p-6">
          <div className="flex items-center justify-between">
            <KortixLogo variant="icon" size={22} className="text-foreground" />
            <span className="bg-destructive/10 text-destructive inline-flex size-8 items-center justify-center rounded-full">
              <WarningCircleIcon className="size-4.5" />
            </span>
          </div>

          <div className="space-y-1.5">
            <h1 className="text-foreground text-lg font-medium tracking-tight">
              {presentation.title}
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed">{presentation.body}</p>
          </div>

          <div className="flex flex-col gap-2.5">
            {presentation.preferReconnect ? (
              <>
                <Button
                  type="button"
                  size="lg"
                  className="w-full"
                  onClick={() => setForcedReconnect(true)}
                >
                  <ArrowSquareOutIcon className="size-4 shrink-0" />
                  {copy.reconnectCta}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="w-full"
                  onClick={() => void statusQuery.refetch()}
                >
                  <ArrowClockwiseIcon className="size-4 shrink-0" />
                  {copy.retrySetup}
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  size="lg"
                  className="w-full"
                  onClick={() => void statusQuery.refetch()}
                >
                  <ArrowClockwiseIcon className="size-4 shrink-0" />
                  {copy.retrySetup}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="w-full"
                  onClick={() => setForcedReconnect(true)}
                >
                  <ArrowSquareOutIcon className="size-4 shrink-0" />
                  {copy.reconnectCta}
                </Button>
              </>
            )}
          </div>

          <div className="border-border border-t pt-3">
            <button
              type="button"
              onClick={() => {
                setRecoveryError(null);
                setShowRecoveryManual((v) => !v);
              }}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between py-1 text-start text-xs font-medium transition-colors"
            >
              <span className="inline-flex items-center gap-1.5">
                <KeyIcon className="size-3.5 shrink-0" />
                {copy.manualToggle}
              </span>
              {showRecoveryManual ? (
                <CaretUpIcon className="size-3.5 shrink-0" />
              ) : (
                <CaretDownIcon className="size-3.5 shrink-0" />
              )}
            </button>
            {showRecoveryManual ? (
              <form onSubmit={(e) => void handleRecoveryManualSave(e)} className="mt-3 space-y-2.5">
                <Input
                  type="password"
                  size="md"
                  placeholder="dtn_..."
                  dir="ltr"
                  value={recoveryKey}
                  onChange={(e) => {
                    setRecoveryError(null);
                    setRecoveryKey(e.target.value);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={recoverySaving}
                />
                {recoveryError ? <FieldError id="recovery-key-err" message={recoveryError} /> : null}
                <Button
                  type="submit"
                  variant="secondary"
                  size="default"
                  className="w-full"
                  disabled={recoverySaving || recoveryKey.trim().length < 16}
                >
                  {recoverySaving ? <Loading className="size-3.5 shrink-0" /> : null}
                  {copy.manualSubmitPost}
                </Button>
              </form>
            ) : null}
          </div>

          <div className="flex justify-center">
            <Button type="button" variant="ghost" size="sm" onClick={() => void performSignOut()}>
              {copy.signOut}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Unconnected or explicit reconnect mode.
  return (
    <AuthFrame>
      {claimError ? <InfoStrip message={claimError} /> : null}
      <DaytonaStepCard
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
      <div className="mt-6 flex justify-center">
        <Button type="button" variant="ghost" size="sm" onClick={() => void performSignOut()}>
          {copy.signOut}
        </Button>
      </div>
    </AuthFrame>
  );
}
