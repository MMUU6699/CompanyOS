// Leader-only Daytona onboarding flow reaper (shared/leader-timer.ts).
// Revokes keys of unclaimed expired flows, clears temporary encrypted keys,
// and recovers stuck 'exchanging' flows whose replica died mid-exchange.

import { logger } from '../../lib/logger';
import {
  reapExpiredDaytonaConnectFlowsOnce,
  retryDueDaytonaSnapshotsOnce,
} from '../../onboarding/daytona-service';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const TICK_MS = 5 * 60_000;

const reaper = leaderTimer(async () => {
  try {
    const result = await runWorkerTick('daytona-flow-reaper', async () => {
      const flows = await reapExpiredDaytonaConnectFlowsOnce();
      const snapshots = await retryDueDaytonaSnapshotsOnce();
      return { flows, snapshots };
    });
    if (
      result &&
      (result.flows.expired > 0 ||
        result.flows.keysRevoked > 0 ||
        result.flows.recoveredExchanging > 0 ||
        result.snapshots.retried > 0)
    ) {
      logger.info('[daytona-flow-reaper] swept flows and retried due snapshots', result);
    }
  } catch (err) {
    logger.error('[daytona-flow-reaper] tick failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return TICK_MS;
});

export const startDaytonaFlowReaper = reaper.start;
export const stopDaytonaFlowReaper = reaper.stop;
