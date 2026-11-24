/**
 * Pure state & copy derivation for the Mobile Cloud Computer (Daytona)
 * settings surface (`CloudComputerSheet` + `AccountPage` status row).
 *
 * Zero React Native imports so all state transitions, error classifications,
 * and EN/AR RTL strings are unit-tested deterministically.
 */

import type { DaytonaOnboardingStatus, DaytonaSnapshotStatus } from './daytona-client';

export type CloudComputerCardState =
  | 'loading'
  | 'offline'
  | 'error'
  | 'not_connected'
  | 'reconnect_required'
  | 'connected_healthy'
  | 'connected_provisioning'
  | 'connected_degraded';

export interface CloudComputerViewModel {
  state: CloudComputerCardState;
  rowBadge: string;
  headline: string;
  subtitle: string;
  orgLabel: string | null;
  regionLabel: string | null;
  snapshotBadge: string | null;
  snapshotTone: 'success' | 'warning' | 'danger' | 'neutral';
  orgSwitchNotice: string | null;
  canRetrySnapshot: boolean;
  canDisconnect: boolean;
  showConnectFlowByDefault: boolean;
  isRtl: boolean;
}

export interface CloudComputerCopy {
  isRtl: boolean;
  sheetTitle: string;
  checking: string;
  offlineTitle: string;
  offlineHint: string;
  loadErrorTitle: string;
  retry: string;
  organization: string;
  region: string;
  runtimeImage: string;
  retryImage: string;
  retryingImage: string;
  switchAccount: string;
  openBilling: string;
  disconnect: string;
  disconnectConfirmTitle: string;
  disconnectConfirmBody: string;
  disconnectConfirmAction: string;
  disconnecting: string;
  cancel: string;
}

const EN_COPY: CloudComputerCopy = {
  isRtl: false,
  sheetTitle: 'Cloud computer',
  checking: 'Checking…',
  offlineTitle: 'Offline',
  offlineHint: 'Reconnect to the network to view or manage your Daytona cloud computer.',
  loadErrorTitle: 'Could not load cloud computer status',
  retry: 'Retry',
  organization: 'Organization',
  region: 'Region',
  runtimeImage: 'Runtime snapshot',
  retryImage: 'Retry snapshot setup',
  retryingImage: 'Retrying snapshot…',
  switchAccount: 'Switch or reconnect Daytona',
  openBilling: 'Open Daytona billing',
  disconnect: 'Disconnect Daytona',
  disconnectConfirmTitle: 'Disconnect Daytona?',
  disconnectConfirmBody:
    'Active cloud computers will be stopped and this Kortix API key will be revoked. Existing sandboxes and files in Daytona are preserved.',
  disconnectConfirmAction: 'Disconnect',
  disconnecting: 'Disconnecting…',
  cancel: 'Cancel',
};

const AR_COPY: CloudComputerCopy = {
  isRtl: true,
  sheetTitle: 'الحاسوب السحابي',
  checking: 'جارٍ التحقق…',
  offlineTitle: 'غير متصل',
  offlineHint: 'أعد الاتصال بالشبكة لعرض أو إدارة حاسوب Daytona السحابي.',
  loadErrorTitle: 'تعذّر تحميل حالة الحاسوب السحابي',
  retry: 'إعادة المحاولة',
  organization: 'المؤسسة',
  region: 'المنطقة',
  runtimeImage: 'صورة بيئة التشغيل',
  retryImage: 'إعادة تهيئة الصورة',
  retryingImage: 'جارٍ إعادة التهيئة…',
  switchAccount: 'تبديل أو إعادة ربط Daytona',
  openBilling: 'فتح فوترة Daytona',
  disconnect: 'فصل حساب Daytona',
  disconnectConfirmTitle: 'فصل حساب Daytona؟',
  disconnectConfirmBody:
    'سيتم إيقاف الحواسيب النشطة مؤقتاً وإلغاء مفتاح الربط الحالي، مع الحفاظ على جميع الحواسيب والملفات داخل Daytona.',
  disconnectConfirmAction: 'فصل الحساب',
  disconnecting: 'جارٍ الفصل…',
  cancel: 'إلغاء',
};

export function getCloudComputerCopy(locale?: string | null): CloudComputerCopy {
  if (locale && locale.toLowerCase().startsWith('ar')) return AR_COPY;
  return EN_COPY;
}

function formatSnapshotBadge(
  status: DaytonaSnapshotStatus | null,
  isAr: boolean,
): { label: string | null; tone: CloudComputerViewModel['snapshotTone'] } {
  switch (status) {
    case 'active':
      return { label: isAr ? 'جاهزة' : 'Ready', tone: 'success' };
    case 'pending':
    case 'pulling':
      return { label: isAr ? 'قيد التحضير' : 'Preparing', tone: 'warning' };
    case 'inactive':
      return { label: isAr ? 'غير نشطة' : 'Inactive', tone: 'warning' };
    case 'failed':
      return { label: isAr ? 'تعذّر التحضير' : 'Needs retry', tone: 'danger' };
    default:
      return { label: isAr ? 'تلقائية عند البدء' : 'On first session', tone: 'neutral' };
  }
}

function shortOrgId(orgId: string | null | undefined): string | null {
  if (!orgId) return null;
  const trimmed = orgId.trim();
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

export function deriveCloudComputerView(input: {
  isLoading: boolean;
  isOffline: boolean;
  errorMessage?: string | null;
  status?: DaytonaOnboardingStatus | null;
  locale?: string | null;
}): CloudComputerViewModel {
  const copy = getCloudComputerCopy(input.locale);
  const isAr = copy.isRtl;

  if (input.isOffline) {
    return {
      state: 'offline',
      rowBadge: copy.offlineTitle,
      headline: copy.offlineTitle,
      subtitle: copy.offlineHint,
      orgLabel: null,
      regionLabel: null,
      snapshotBadge: null,
      snapshotTone: 'neutral',
      orgSwitchNotice: null,
      canRetrySnapshot: false,
      canDisconnect: false,
      showConnectFlowByDefault: false,
      isRtl: isAr,
    };
  }

  if (input.isLoading && !input.status) {
    return {
      state: 'loading',
      rowBadge: copy.checking,
      headline: copy.checking,
      subtitle: '',
      orgLabel: null,
      regionLabel: null,
      snapshotBadge: null,
      snapshotTone: 'neutral',
      orgSwitchNotice: null,
      canRetrySnapshot: false,
      canDisconnect: false,
      showConnectFlowByDefault: false,
      isRtl: isAr,
    };
  }

  if (input.errorMessage && !input.status) {
    return {
      state: 'error',
      rowBadge: isAr ? 'خطأ في التحقق' : 'Status unavailable',
      headline: copy.loadErrorTitle,
      subtitle: input.errorMessage,
      orgLabel: null,
      regionLabel: null,
      snapshotBadge: null,
      snapshotTone: 'danger',
      orgSwitchNotice: null,
      canRetrySnapshot: false,
      canDisconnect: false,
      showConnectFlowByDefault: false,
      isRtl: isAr,
    };
  }

  const s = input.status;
  if (!s || !s.connected) {
    return {
      state: 'not_connected',
      rowBadge: isAr ? 'غير مرتبط' : 'Not connected',
      headline: isAr ? 'اربط حساب Daytona الخاص بك' : 'Connect your Daytona account',
      subtitle: isAr
        ? 'تعمل كل جلسة داخل حاسوب سحابي معزول في حساب Daytona الخاص بك.'
        : 'Each session runs in an isolated cloud computer inside your own Daytona workspace.',
      orgLabel: null,
      regionLabel: null,
      snapshotBadge: null,
      snapshotTone: 'neutral',
      orgSwitchNotice: null,
      canRetrySnapshot: false,
      canDisconnect: false,
      showConnectFlowByDefault: true,
      isRtl: isAr,
    };
  }

  if (s.reconnectRequired) {
    return {
      state: 'reconnect_required',
      rowBadge: isAr ? 'يلزم إعادة الربط' : 'Reconnect required',
      headline: isAr ? 'يلزم إعادة ربط Daytona' : 'Reconnect your Daytona workspace',
      subtitle:
        s.snapshotError ||
        s.warning ||
        (isAr
          ? 'انتهت صلاحية مفتاح Daytona الحالي أو تم إلغاؤه.'
          : 'Your saved Daytona API key expired or was revoked.'),
      orgLabel: shortOrgId(s.orgId),
      regionLabel: s.region ? s.region.toUpperCase() : null,
      snapshotBadge: null,
      snapshotTone: 'danger',
      orgSwitchNotice: null,
      canRetrySnapshot: false,
      canDisconnect: true,
      showConnectFlowByDefault: true,
      isRtl: isAr,
    };
  }

  const snap = formatSnapshotBadge(s.snapshotStatus, isAr);
  const orgSwitchNotice =
    s.orgSwitched && s.previousOrgId
      ? isAr
        ? `تم التبديل من المؤسسة السابقة (${shortOrgId(s.previousOrgId)}). تبقى الجلسات القديمة في المؤسسة السابقة.`
        : `Switched from previous workspace (${shortOrgId(s.previousOrgId)}). Earlier sessions remain in that workspace.`
      : s.warning || null;

  if (s.snapshotStatus === 'failed' || s.snapshotStatus === 'inactive') {
    return {
      state: 'connected_degraded',
      rowBadge: isAr ? 'متصل · يحتاج انتباهاً' : 'Connected · Needs attention',
      headline: isAr ? 'Daytona متصل (الصورة غير جاهزة)' : 'Daytona connected · Snapshot needs retry',
      subtitle:
        s.snapshotError ||
        (isAr
          ? 'تحقّق من رصيد Daytona أو أعد تهيئة صورة بيئة التشغيل.'
          : 'Check your Daytona credits or retry preparing the runtime snapshot.'),
      orgLabel: shortOrgId(s.orgId),
      regionLabel: s.region ? s.region.toUpperCase() : null,
      snapshotBadge: snap.label,
      snapshotTone: snap.tone,
      orgSwitchNotice,
      canRetrySnapshot: true,
      canDisconnect: true,
      showConnectFlowByDefault: false,
      isRtl: isAr,
    };
  }

  if (s.snapshotStatus === 'pending' || s.snapshotStatus === 'pulling') {
    return {
      state: 'connected_provisioning',
      rowBadge: isAr ? 'متصل · يُجهّز' : 'Connected · Preparing',
      headline: isAr ? 'Daytona متصل' : 'Daytona connected',
      subtitle: isAr
        ? 'يتم تجهيز صورة بيئة التشغيل تلقائياً في الخلفية.'
        : 'Preparing your runtime snapshot in the background.',
      orgLabel: shortOrgId(s.orgId),
      regionLabel: s.region ? s.region.toUpperCase() : null,
      snapshotBadge: snap.label,
      snapshotTone: snap.tone,
      orgSwitchNotice,
      canRetrySnapshot: false,
      canDisconnect: true,
      showConnectFlowByDefault: false,
      isRtl: isAr,
    };
  }

  return {
    state: 'connected_healthy',
    rowBadge: isAr ? 'متصل (Daytona)' : 'Connected (Daytona)',
    headline: isAr ? 'حاسوب Daytona متصل وجاهز' : 'Daytona cloud computer connected',
    subtitle: isAr
      ? 'تعمل جميع الجلسات الجديدة والحالية على حساب Daytona الخاص بك.'
      : 'Every session provisions and resumes inside your personal Daytona organization.',
    orgLabel: shortOrgId(s.orgId),
    regionLabel: s.region ? s.region.toUpperCase() : null,
    snapshotBadge: snap.label,
    snapshotTone: snap.tone,
    orgSwitchNotice,
    canRetrySnapshot: false,
    canDisconnect: true,
    showConnectFlowByDefault: false,
    isRtl: isAr,
  };
}
