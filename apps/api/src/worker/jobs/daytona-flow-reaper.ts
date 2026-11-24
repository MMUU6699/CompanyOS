// Leader-only Daytona onboarding flow reaper (shared/leader-timer.ts).
// Revokes keys of unclaimed expired flows, clears temporary encrypted keys,
// and recovers stuck 'exchanging' flows whose replica died mid-exchange.

import { logger } from '../../lib/logger';
import { reapExpiredDaytonaConnectFlowsOnce } from '../../onboarding/daytona-service';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const TICK_MS = 5 * 60_000;

const reaper = leaderTimer(async () => {
  try {
    const result = await runWorkerTick('daytona-flow-reaper', reapExpiredDaytonaConnectFlowsOnce);
    if (result && (result.expired > 0 || result.keysRevoked > 0 || result.recoveredExchanging > 0)) {
      logger.info('[daytona-flow-reaper] swept expired onboarding flows', result);
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
