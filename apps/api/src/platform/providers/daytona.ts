/**
 * Daytona sandbox provider.
 *
 * Creates sandboxes in Daytona Cloud from a pre-built snapshot.
 * Extracted from the original account.ts provisioning logic.
 */

import type { SandboxExecOptions, SandboxExecResult } from './contract';
import { isProviderNotFound } from './status';
import { SandboxState } from '@daytonaio/sdk';
import { SANDBOX_VERSION, config } from '../../config';
import {
  ensureDaytonaCapacitySlot,
  evictIdleRunningDaytonaSandboxes,
  reclaimDaytonaDiskSlots,
} from '../../projects/compute-quota-guard';
import { triggerEmergencyDiskArchiveSweep } from '../../projects/disk-quota-guard';
import {
  archiveDaytonaSandboxById,
  getDaytona,
  getDaytonaSandboxStateById,
  isDaytonaComputeQuotaError,
  isDaytonaDiskQuotaError,
  listStartedDaytonaSandboxesOldestFirst,
  listStoppedDaytonaSandboxesOldestFirst,
  stopDaytonaSandboxById,
} from '../../shared/daytona';
import {
  DaytonaReconnectRequiredError,
  ensureUserSnapshotActive,
  invalidateUserDaytonaCache,
  isDaytonaCredentialRejectedError,
  rememberExternalIdOwner,
  resolveDaytonaContextForExternalId,
  resolveDaytonaContextForOwner,
  type UserDaytonaContext,
} from '../../onboarding/daytona-service';
import { configuredTimeoutMs, withTimeout } from '../../shared/with-timeout';
import { serviceKeyForExternalId } from '../service-key';
import { sandboxFrontendBaseUrl } from '../sandbox-frontend-url';
import {
  assertWorkloadCredential,
  providerAutoStopBackstopMinutes,
  sandboxWorkloadType,
} from './contract';
import { classifyDaytonaState } from './daytona-state';
import { sandboxOwnershipMarker } from '../sandbox-ownership';

// The Daytona SDK's axios client is created with a 24-HOUR timeout (see
// @daytonaio/sdk's Daytona.createAxiosInstance) — effectively unbounded for
// every non-create call (get/start/stop/delete/list all share it; only
// create() takes its own {timeout} option, honored by the SDK's own polling
// loop). A single degraded upstream request on any of these calls hangs the
// awaiting caller indefinitely. That is silently catastrophic on the reaper's
// hot path (sandbox-reaper.ts): one stuck `getStatus`/`stop` call never lets
// its Promise.all settle, which never lets runProjectMaintenance's outer
// Promise.all settle, which means its `finally` never runs — the
// maintenanceRunning lock is stuck `true` forever and every future 5-minute
// tick silently no-ops with zero error logs. Only a process restart clears the
// in-memory flag. (Traced live 2026-07-02: prod accumulated $39k+ in idle
// compute over-billing before this was found — see maintenance.ts's watchdog
// for the second line of defense.)
//
// Every method below that awaits the SDK directly is bounded with
// `withTimeout` so a hung upstream fails fast and observably instead of
// hanging for up to a day.
const PROVIDER_CALL_TIMEOUT_MS = configuredTimeoutMs(
  'KORTIX_DAYTONA_CALL_TIMEOUT_MS',
  20_000,
  1_000,
);
// listManagedRunningSandboxes() pages through the org's whole managed fleet —
// a large fleet can legitimately take longer than one single-call budget to
// fully list, and PROVIDER_CALL_TIMEOUT_MS would then look identical to a
// genuine hang (silently starving the orphan-box reaper). Give it its own,
// longer budget instead of reusing the single-call one.
const LIST_OPERATION_TIMEOUT_MS = configuredTimeoutMs(
  'KORTIX_DAYTONA_LIST_TIMEOUT_MS',
  90_000,
  PROVIDER_CALL_TIMEOUT_MS,
);

function buildDiskQuotaGuardDeps(apiKey?: string) {
  return {
    list: (maxItems: number) => listStoppedDaytonaSandboxesOldestFirst(maxItems, apiKey),
    archive: (id: string) => archiveDaytonaSandboxById(id, apiKey),
  };
}

function buildSlotManagerDeps(apiKey?: string) {
  return {
    listStarted: (maxItems: number) => listStartedDaytonaSandboxesOldestFirst(maxItems, apiKey),
    listStopped: (maxItems: number) => listStoppedDaytonaSandboxesOldestFirst(maxItems, apiKey),
    stop: (id: string) => stopDaytonaSandboxById(id, apiKey),
    archive: (id: string) => archiveDaytonaSandboxById(id, apiKey),
    getState: (id: string) => getDaytonaSandboxStateById(id, apiKey),
  };
}

function handleUserAuthFailure(err: unknown, userCtx: UserDaytonaContext | null): void {
  if (userCtx && isDaytonaCredentialRejectedError(err)) {
    invalidateUserDaytonaCache(userCtx.userId);
    throw new DaytonaReconnectRequiredError();
  }
}

function isTransientDaytonaWakeError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = (err as { status?: number; response?: { status?: number } })?.status
    ?? (err as { response?: { status?: number } })?.response?.status;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  return (
    msg.includes('429') ||
    msg.includes('throttler') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  );
}

/**
 * Proactive LRU slot check + reactive quota/transient retry wrapper shared by
 * Daytona `create()` and `start()`. Partitioned strictly per `daytonaOrgId` so
 * User A never blocks or evicts User B.
 */
async function runWithDaytonaQuotaRetry<T>(
  reason: string,
  excludeExternalId: string | undefined,
  userCtx: UserDaytonaContext | null,
  op: () => Promise<T>,
): Promise<T> {
  const slotManagerDeps = buildSlotManagerDeps(userCtx?.apiKey);
  const partitionKey = userCtx?.daytonaOrgId ?? 'global';
  const maxRunning = userCtx ? 2 : config.KORTIX_DAYTONA_MAX_RUNNING_SANDBOXES;
  const maxNonArchived = userCtx ? 2 : config.KORTIX_DAYTONA_MAX_NON_ARCHIVED_SANDBOXES;

  await ensureDaytonaCapacitySlot(
    reason,
    slotManagerDeps,
    { maxRunning, maxNonArchived },
    excludeExternalId,
    partitionKey,
  ).catch((err: unknown) => {
    handleUserAuthFailure(err, userCtx);
    console.warn(
      `[DAYTONA:${partitionKey}] proactive LRU slot check (${reason}) skipped:`,
      err instanceof Error ? err.message : String(err),
    );
  });

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      handleUserAuthFailure(err, userCtx);
      if (attempt < maxAttempts) {
        if (isDaytonaDiskQuotaError(err)) {
          const reclaim = await reclaimDaytonaDiskSlots(
            `${reason}:attempt-${attempt}`,
            slotManagerDeps,
            excludeExternalId,
            undefined,
            partitionKey,
          );
          if (reclaim.archivedIds.length > 0) {
            for (const id of reclaim.archivedIds) runningStatusCache.delete(id);
            continue;
          }
        } else if (isDaytonaComputeQuotaError(err)) {
          const eviction = await evictIdleRunningDaytonaSandboxes(
            `${reason}:attempt-${attempt}`,
            slotManagerDeps,
            excludeExternalId,
            partitionKey,
          );
          if (eviction.evictedIds.length > 0) {
            for (const id of eviction.evictedIds) runningStatusCache.delete(id);
            continue;
          }
        } else if (isTransientDaytonaWakeError(err)) {
          const delayMs = attempt * 1_500;
          console.warn(
            `[DAYTONA:${partitionKey}] transient error on ${reason} (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms:`,
            err instanceof Error ? err.message : String(err),
          );
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
      reportIfDiskQuotaError(err, reason, userCtx?.apiKey);
    }
  }
  throw new Error(`Daytona ${reason} exhausted retries`);
}

/**
 * Any Daytona create/resume call can hit the org-wide disk quota. Firing the
 * emergency archive sweep here (rather than in every call site) means every
 * create/resume path is covered by one guard; the sweep is cooldown +
 * single-flight gated so a burst of concurrent failures triggers it once.
 * Always rethrows — this never rescues the request that hit the error.
 */
function reportIfDiskQuotaError(err: unknown, reason: string, apiKey?: string): never {
  console.error(
    `[DAYTONA] ${reason} failed:`,
    err instanceof Error ? err.message : String(err),
  );
  if (isDaytonaDiskQuotaError(err)) {
    triggerEmergencyDiskArchiveSweep(reason, buildDiskQuotaGuardDeps(apiKey));
  }
  throw err;
}
// (DAYTONA_SNAPSHOT was removed — every sandbox boots from its project's
// own per-project snapshot, resolved by the snapshot builder. Callers
// must pass `opts.snapshot`; there is no shared platform-wide image.)

// Labels stamped on every Kortix-managed Daytona box at create time. The
// Daytona org is SHARED across environments (prod / dev / laptops), so the
// orphan-box reaper MUST scope its sweep to this deployment's own boxes —
// otherwise one env would stop another env's sandboxes. `kortix.managed` marks
// "we created it"; `kortix.env` pins the owning environment. The reaper lists
// by exactly these labels (see listManagedRunningSandboxes).
export async function managedSandboxLabels(workloadType?: SandboxWorkloadType): Promise<Record<string, string>> {
  return {
    'kortix.managed': await sandboxOwnershipMarker(),
    'kortix.env': config.INTERNAL_KORTIX_ENV,
    ...(workloadType === 'app' ? { 'kortix.workload': workloadType } : {}),
  };
}
import type {
  SandboxProvider,
  ProviderName,
  CreateSandboxOpts,
  ProvisionResult,
  SandboxStatus,
  ResolvedEndpoint,
  ProvisioningTraits,
  ProvisioningStatus,
  ResolvedSandboxIngress,
  SandboxIngressRequest,
  SandboxWorkloadType,
} from './contract';

// Short-TTL cache for getStatus on the session-open hot path. POST /sessions/:id/start
// is polled ~every 800ms and each poll did an UNCACHED daytona.get() (~150-600ms)
// just to confirm a snapshot-restored sandbox is still running — pure overhead that
// dominates the warm-start server cost. Box state changes far slower than the poll
// cadence, so caching the 'running' verdict briefly collapses ~2/3 of those
// provider round-trips. Only 'running' is cached (never 'stopped'/'unknown'), so
// idle-stop / wake detection always reads fresh; start/stop/remove bust the entry.
const STATUS_CACHE_TTL_MS = 1500;
const runningStatusCache = new Map<string, number>(); // externalId → cachedAt (ms)

const DESKTOP_REPAIR_COOLDOWN_MS = 60_000;
const DESKTOP_REPAIR_TIMEOUT_MS = 15_000;
const desktopRepairCooldown = new Map<string, number>();
const desktopRepairInflight = new Map<string, Promise<boolean>>();

/**
 * Self-heal stale `/tmp/.X1-lock` on resumed Daytona sandboxes.
 *
 * Daytona preserves `/tmp` across stop→start while processes do not survive.
 * Images built before the `entrypoint.sh` lock cleanup leave `/tmp/.X1-lock`
 * behind on resume, so `Xvfb :1` exits with "Server is already active for
 * display 1" and `voxl` loops forever unable to bind port 6901.
 *
 * Single-flight and 60s cooldown gated per sandbox so concurrent desktop
 * probes trigger at most one fast repair command.
 */
export function repairDaytonaDesktopIfStale(externalId: string): Promise<boolean> {
  const inflight = desktopRepairInflight.get(externalId);
  if (inflight) return inflight;
  const lastAt = desktopRepairCooldown.get(externalId);
  if (lastAt !== undefined && Date.now() - lastAt < DESKTOP_REPAIR_COOLDOWN_MS) {
    return Promise.resolve(false);
  }
  desktopRepairCooldown.set(externalId, Date.now());
  const task = (async () => {
    try {
      const userCtx = await resolveDaytonaContextForExternalId(externalId).catch(() => null);
      const daytona = userCtx?.client ?? getDaytona();
      const sandbox = await withTimeout(
        daytona.get(externalId),
        DESKTOP_REPAIR_TIMEOUT_MS,
        `Daytona get(${externalId}) for desktop repair`,
      );
      if (classifyDaytonaState(sandbox.state) !== 'running') return false;
      const cmd =
        'bash -lc \'if command -v voxl >/dev/null 2>&1 && ! curl -fs -o /dev/null http://127.0.0.1:6901/; then ' +
        'if ! pgrep -x Xvfb >/dev/null 2>&1; then ' +
        'kortix-desktop stop >/dev/null 2>&1 || true; ' +
        'rm -f /tmp/.X1-lock /tmp/.X11-unix/X1; ' +
        'KORTIX_DESKTOP_SESSION_DELAY_S=0 kortix-desktop start >/dev/null 2>&1 || true; ' +
        'echo repaired; fi; fi\'';
      const result = await withTimeout(
        sandbox.process.executeCommand(cmd, undefined, undefined, 12),
        DESKTOP_REPAIR_TIMEOUT_MS,
        `Daytona desktop repair(${externalId})`,
      );
      const repaired = Boolean(result.result?.includes('repaired'));
      if (repaired) {
        console.log(`[DAYTONA] repaired stale X11 lock and restarted desktop on ${externalId}`);
      }
      return repaired;
    } catch (err) {
      console.warn(
        `[DAYTONA] desktop self-heal failed for ${externalId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    } finally {
      desktopRepairInflight.delete(externalId);
    }
  })();
  desktopRepairInflight.set(externalId, task);
  return task;
}

/**
 * Daytona sandbox lifecycle policy, applied as SDK create() params so a box
 * self-manages even when the API/tunnel that created it dies — orphaned
 * local-dev and ephemeral-env sessions are the dominant leak source, and the
 * idle sweep can't see boxes it has no DB row for.
 *
 *  - autoStopInterval: idle → stop. CLAMPED to >= 1 so a box is NEVER created
 *    persistent. BACKSTOP only: Daytona's idle signal is "no inbound requests",
 *    blind to local tool runs, so it must sit well above the longest real turn or
 *    it kills working boxes. Sized by providerAutoStopBackstopMinutes(), which is
 *    that policy and nothing else — it used to double as the billing clamp's
 *    grace, which is why it was pinned 12x too low to be safe here.
 *  - autoArchiveInterval: stopped → archived to cold storage after a few days
 *    (cheap, still resumable). Until then the stopped box stays warm-resumable.
 *  - autoDeleteInterval: -1 by default → NEVER auto-delete. An idle box is
 *    nearly free once stopped + cold-archived, so we never destroy its disk;
 *    a session is only removed when the user explicitly deletes it.
 */
export function daytonaLifecycle(autoStopOverride?: number): {
  autoStopInterval: number;
  autoArchiveInterval: number;
  autoDeleteInterval: number;
} {
  const stop = autoStopOverride ?? providerAutoStopBackstopMinutes();
  return {
    autoStopInterval: Math.max(1, stop),
    autoArchiveInterval: config.KORTIX_SANDBOX_AUTOARCHIVE_MINUTES,
    autoDeleteInterval: config.KORTIX_SANDBOX_AUTODELETE_MINUTES,
  };
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export class DaytonaProvider implements SandboxProvider {
  readonly name: ProviderName = 'daytona';

  readonly provisioning: ProvisioningTraits = {
    async: false,
    stages: [{ id: 'creating', progress: 50, message: 'Creating sandbox...' }],
  };

  async getProvisioningStatus(): Promise<ProvisioningStatus | null> {
    return null;
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    const workloadType = sandboxWorkloadType(opts);
    // KORTIX_URL is the public API base URL the sandbox calls back on. Strip
    // any route suffix so older env files that included /v1 or /v1/router still
    // resolve to the bare origin.
    const sandboxApiBase = config.KORTIX_URL
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');

    const createTimeoutSeconds = Math.max(
      1,
      Number.parseInt(process.env.KORTIX_DAYTONA_CREATE_TIMEOUT_SECONDS || '30', 10) || 30,
    );

    const envVars: Record<string, string> = {
      // Guarantee the sandbox contract even if a caller forgets: the runtime only
      // needs KORTIX_API_URL + KORTIX_TOKEN; tools derive every router endpoint
      // from KORTIX_API_URL and auth with KORTIX_TOKEN.
      KORTIX_API_URL: `${sandboxApiBase}/v1`,
      // Frontend base for user-facing dashboard links (never the API host).
      // Guaranteed here too so it is present even if a caller's env map omits it.
      KORTIX_FRONTEND_URL: sandboxFrontendBaseUrl(),
      ...(workloadType === 'app' ? { KORTIX_WORKLOAD_TYPE: workloadType } : {}),
      // Session identity, git context, KORTIX_TOKEN, and the project's own
      // secrets (incl. provider keys set via `kortix providers`, picked up by
      // the runtime at boot) — see buildSessionSandboxEnvVars() and
      // provisionSessionSandbox().
      ...opts.envVars,
    };
    assertWorkloadCredential(this.name, opts, envVars);

    const userCtx = await resolveDaytonaContextForOwner({
      userId: opts.userId,
      accountId: opts.accountId,
    });

    // Resolve the snapshot to boot from:
    // - If the workspace owner connected their own Daytona account, ensure
    //   the pinned GHCR snapshot is active in THEIR org (auto-activating if
    //   Daytona deactivated it after 14 days).
    // - Otherwise fall back to the caller-supplied opts.snapshot on the
    //   legacy deployment Daytona org.
    let snapshot = opts.snapshot;
    if (userCtx) {
      const ensured = await ensureUserSnapshotActive(userCtx);
      snapshot = ensured.snapshotName;
    }
    if (!snapshot) {
      throw new Error(
        'Daytona create() called without opts.snapshot. ' +
          'Every sandbox must boot from a per-project snapshot built by ' +
          'apps/api/src/snapshots/builder.ts. There is no shared fallback.',
      );
    }

    const daytona = userCtx?.client ?? getDaytona();
    const labels = await managedSandboxLabels(workloadType);
    const lifecycle = userCtx
      ? {
          autoStopInterval: Math.max(1, Math.min(opts.autoStopInterval ?? 5, 5)),
          autoArchiveInterval: Math.max(1, Math.min(config.KORTIX_SANDBOX_AUTOARCHIVE_MINUTES, 5)),
          autoDeleteInterval: config.KORTIX_SANDBOX_AUTODELETE_MINUTES,
        }
      : daytonaLifecycle(opts.autoStopInterval);
    const createParams = {
      snapshot,
      envVars,
      ...lifecycle,
      labels,
      public: false,
    };

    const runCreate = () =>
      daytona.create(createParams, { timeout: createTimeoutSeconds });

    const daytonaSandbox = await runWithDaytonaQuotaRetry('create', undefined, userCtx, runCreate);

    const externalId = daytonaSandbox.id;
    if (userCtx) {
      rememberExternalIdOwner(externalId, userCtx.userId, userCtx.daytonaOrgId);
      console.log(
        `[DAYTONA] created sandbox ${externalId} in user org ${userCtx.daytonaOrgId} (region=${userCtx.daytonaRegion}, snapshot=${snapshot})`,
      );
    }
    const apiBase = sandboxApiBase;
    const ingressPort = workloadType === 'app' ? 8080 : 8000;
    const baseUrl = `${apiBase}/v1/p/${externalId}/${ingressPort}`;

    // Warm the preview route NOW, so the edge is live before anything asks for it.
    // The Platinum provider has always done the equivalent (its eager
    // POST /:id/expose, platinum.ts) precisely because a lazily-routed edge left a
    // window where the first /agent | /session | /global/events call hit an
    // un-routed edge and 504'd right after runtime-ready. Daytona had no
    // counterpart: every session paid getPreviewLink (~179ms measured) on its
    // first proxied request, plus whatever the edge needs to start routing — and
    // that lands squarely inside the window where the frontend is already polling
    // readiness. Measured 2026-07-25, `daemon_reachable` trails `vm_created` by
    // 0-3.8s on Daytona (vs 16ms-1.8s on Platinum), and this asymmetry is a
    // plausible part of that spread.
    //
    // Strictly best-effort and NOT awaited into the result: resolveIngress()
    // still resolves the link lazily, so a failure here costs nothing beyond the
    // old behaviour. Bounded so a hung Daytona call cannot outlive the provision.
    void withTimeout(
      (daytonaSandbox as any).getPreviewLink(ingressPort),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona eager getPreviewLink(${externalId}:${ingressPort})`,
    ).catch((err: unknown) => {
      console.warn(
        `[DAYTONA] eager preview-link warm for ${externalId} failed (lazy fallback):`,
        err instanceof Error ? err.message : String(err),
      );
    });

    return {
      externalId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        daytonaSandboxId: externalId,
        ...(userCtx
          ? {
              daytonaOrgId: userCtx.daytonaOrgId,
              daytonaOwnerUserId: userCtx.userId,
              daytonaRegion: userCtx.daytonaRegion,
            }
          : {}),
        snapshot,
        version: SANDBOX_VERSION,
        workloadType,
      },
    };
  }

  /**
   * Daytona runs its own `/usr/local/bin/daytona` entrypoint and does not run
   * the image ENTRYPOINT. Start appd through the toolbox after every create or
   * wake. The PID-file check makes concurrent and repeated calls idempotent.
   */
  async ensureAppRuntimeStarted(externalId: string): Promise<void> {
    const userCtx = await resolveDaytonaContextForExternalId(externalId).catch(() => null);
    const daytona = userCtx?.client ?? getDaytona();
    const sandbox = await withTimeout(
      daytona.get(externalId),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona get(${externalId}) for App bootstrap`,
    );
    const command = '/kortix/bin/kortix-appd --daemon';
    const result = await withTimeout(
      sandbox.process.executeCommand(command, undefined, undefined, 15),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona App bootstrap(${externalId})`,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Daytona App bootstrap failed for ${externalId}: exit ${result.exitCode}: ${result.result.slice(0, 500)}`,
      );
    }
  }

  async exec(
    externalId: string,
    command: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const userCtx = await resolveDaytonaContextForExternalId(externalId).catch(() => null);
    const daytona = userCtx?.client ?? getDaytona();
    const sandbox = await withTimeout(
      daytona.get(externalId),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona get(${externalId}) for exec`,
    );
    const line = command.map(shellQuote).join(' ');
    const result = await withTimeout(
      sandbox.process.executeCommand(line, undefined, undefined, Math.ceil(opts.timeoutMs / 1000)),
      opts.timeoutMs + 30_000,
      `Daytona exec(${externalId})`,
    );
    return { exitCode: result.exitCode, stdout: result.result ?? '', stderr: '' };
  }

  async start(externalId: string): Promise<void> {
    runningStatusCache.delete(externalId);
    const userCtx = await resolveDaytonaContextForExternalId(externalId);
    const daytona = userCtx?.client ?? getDaytona();
    let sandbox: Awaited<ReturnType<typeof daytona.get>>;
    try {
      sandbox = await withTimeout(
        daytona.get(externalId),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona get(${externalId})`,
      );
    } catch (err) {
      handleUserAuthFailure(err, userCtx);
      throw err;
    }
    const runStart = () =>
      withTimeout(
        sandbox.start(),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona start(${externalId})`,
      );
    await runWithDaytonaQuotaRetry(`resume:${externalId}`, externalId, userCtx, runStart);
    // Daytona preserves /tmp/.X1-lock across stop→start, which kills Xvfb :1
    // on existing images; heal asynchronously right after resume so Desktop
    // (:6901) is up immediately without delaying the wake response.
    desktopRepairCooldown.delete(externalId);
    void repairDaytonaDesktopIfStale(externalId);
  }

  async renewLifecycle(externalId: string): Promise<void> {
    const userCtx = await resolveDaytonaContextForExternalId(externalId).catch(() => null);
    const daytona = userCtx?.client ?? getDaytona();
    const sandbox = await withTimeout(
      daytona.get(externalId),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona get(${externalId}) for lifecycle renewal`,
    );
    if (classifyDaytonaState(sandbox.state) !== 'running') {
      throw new Error(`Daytona lifecycle renewal refused for non-running sandbox ${externalId}`);
    }
    // Guest commands do not reset Daytona's lifecycle clock. Use the provider's
    // dedicated activity endpoint. The state gate above prevents this call from
    // granting activity to a stopped sandbox.
    await withTimeout(
      sandbox.refreshActivity(),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona lifecycle renewal(${externalId})`,
    );
  }

  async stop(externalId: string): Promise<void> {
    runningStatusCache.delete(externalId);
    const userCtx = await resolveDaytonaContextForExternalId(externalId).catch(() => null);
    const daytona = userCtx?.client ?? getDaytona();
    const sandbox = await withTimeout(
      daytona.get(externalId),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona get(${externalId})`,
    );
    await withTimeout(
      // Pass the same bound into the SDK. Its outer `withTimeout` cannot cancel
      // a losing promise, while the SDK forwards this value to axios and the
      // server-side wait. The stop-claim lease relies on no stale stop request
      // surviving after this method rejects.
      sandbox.stop(PROVIDER_CALL_TIMEOUT_MS / 1000),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona stop(${externalId})`,
    );
  }

  async remove(externalId: string): Promise<void> {
    runningStatusCache.delete(externalId);
    const userCtx = await resolveDaytonaContextForExternalId(externalId).catch(() => null);
    const daytona = userCtx?.client ?? getDaytona();
    const sandbox = await withTimeout(
      daytona.get(externalId),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona get(${externalId})`,
    );
    await withTimeout(
      daytona.delete(sandbox),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona delete(${externalId})`,
    );
  }

  /**
   * List THIS environment's running boxes, for the orphan-box reaper. Scoped by
   * the managed labels — the Daytona org is shared across environments, so an
   * unscoped sweep would reap other deployments' sandboxes. Returns id +
   * createdAt so the reaper can age-gate (never stop a box inside its grace
   * window, which would race a box mid-provision before its DB row lands).
   */
  async listManagedRunningSandboxes(): Promise<
    Array<{ externalId: string; createdAt: Date | null }>
  > {
    // Bounds the WHOLE paginated iteration, not just one page — the async
    // generator can page indefinitely if a later page's request hangs.
    return withTimeout(
      (async () => {
        const out: Array<{ externalId: string; createdAt: Date | null }> = [];
        for await (const box of getDaytona().list({
          states: [SandboxState.STARTED],
          labels: await managedSandboxLabels(),
          limit: 100,
        } as any)) {
          const externalId = (box as { id?: string }).id;
          if (!externalId) continue;
          const raw =
            (box as { createdAt?: string | Date }).createdAt ??
            (box as { info?: { createdAt?: string | Date } }).info?.createdAt ??
            null;
          out.push({ externalId, createdAt: raw ? new Date(raw) : null });
        }
        return out;
      })(),
      LIST_OPERATION_TIMEOUT_MS,
      'Daytona list(managed running sandboxes)',
    );
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    const cachedAt = runningStatusCache.get(externalId);
    if (cachedAt !== undefined && Date.now() - cachedAt < STATUS_CACHE_TTL_MS) return 'running';
    try {
      const userCtx = await resolveDaytonaContextForExternalId(externalId).catch(() => null);
      const daytona = userCtx?.client ?? getDaytona();
      const sandbox = await withTimeout(
        daytona.get(externalId),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona get(${externalId})`,
      );
      const status = classifyDaytonaState(sandbox.state);
      if (status === 'running') {
        runningStatusCache.set(externalId, Date.now());
        return 'running';
      }
      runningStatusCache.delete(externalId);
      return status;
    } catch (err) {
      runningStatusCache.delete(externalId);
      if (isProviderNotFound(err)) return 'removed';
      return 'unknown';
    }
  }

  async resolveIngress(
    externalId: string,
    request: SandboxIngressRequest,
  ): Promise<ResolvedSandboxIngress> {
    const userCtx = await resolveDaytonaContextForExternalId(externalId).catch(() => null);
    const daytona = userCtx?.client ?? getDaytona();
    let sandbox: Awaited<ReturnType<typeof daytona.get>>;
    try {
      sandbox = await withTimeout(
        daytona.get(externalId),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona get(${externalId})`,
      );
    } catch (err) {
      handleUserAuthFailure(err, userCtx);
      throw err;
    }
    const link: any = await withTimeout(
      (sandbox as any).getPreviewLink(request.port),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona getPreviewLink(${externalId}:${request.port})`,
    );
    const headers: Record<string, string> = {
      'X-Daytona-Skip-Preview-Warning': 'true',
      'X-Daytona-Disable-CORS': 'true',
    };
    if (link.token) headers['X-Daytona-Preview-Token'] = link.token;
    return {
      url: (link.url || String(link)).replace(/\/$/, ''),
      headers,
      effectivePort: request.port,
    };
  }

  routeIngress(request: SandboxIngressRequest) {
    return { effectivePort: request.port };
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const ingress = await this.resolveIngress(externalId, { port: 8000, transport: 'http' });
    const headers: Record<string, string> = {
      ...ingress.headers,
      'Content-Type': 'application/json',
    };

    // Look up the service key (sandboxes OR session_sandboxes) to authenticate to the sandbox.
    try {
      const serviceKey = await serviceKeyForExternalId(externalId);
      if (serviceKey) {
        headers['Authorization'] = `Bearer ${serviceKey}`;
      }
    } catch (err) {
      console.warn(`[DAYTONA] Failed to look up service key for ${externalId}:`, err);
    }

    return { url: ingress.url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    console.log(`[DAYTONA] Sandbox ${externalId} is ${status}, waking up...`);
    await this.start(externalId);
  }
}
