/**
 * Deploy-time / CI check: compare the pinned per-user Daytona sandbox image
 * (`KORTIX_SANDBOX_GHCR_IMAGE`) against the current checkout's runtime assets
 * (`managed_skills_hash`, `apps/cli`, `apps/kortix-sandbox-agent-server`) and
 * verify anonymous OCI pullability on GHCR.
 *
 * USAGE:
 *   bun apps/api/scripts/check-sandbox-image-drift.ts           # warn-only (exit 0 unless unpullable)
 *   bun apps/api/scripts/check-sandbox-image-drift.ts --strict  # exit 1 on any runtime drift
 *
 * HOW TO PUBLISH A MATCHING SANDBOX IMAGE (operator runbook):
 *   1. Push the target branch (`dev`) to GitHub (`MMUU6699/CompanyOS`).
 *   2. Dispatch `.github/workflows/publish-kortix-sandbox-image.yml`:
 *        gh workflow run publish-kortix-sandbox-image.yml --repo MMUU6699/CompanyOS --ref dev
 *   3. Wait for the workflow to print `PUBLISHED_IMAGE=ghcr.io/<owner>/kortix-sandbox:<YYYYMMDD>-<sha8>`
 *      and confirm package visibility is Public in GitHub Packages.
 *   4. Update `DEFAULT_PINNED_SANDBOX_IMAGE` in `apps/api/src/onboarding/daytona-service.ts`
 *      (and `KORTIX_SANDBOX_GHCR_IMAGE` on Railway if overridden) to the new immutable tag,
 *      re-run this script (`--strict` must exit 0), and redeploy `kortix-api`.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedSkillOverlayFiles, managedSkillOverlayHash } from '../src/runtime-assets/managed-skills';

const FALLBACK_PINNED_SANDBOX_IMAGE = 'ghcr.io/mmuu6699/kortix-sandbox:20261121-da3f5cdd';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

const RUNTIME_PATHS = [
  'packages/starter/templates',
  'packages/starter/src',
  'apps/cli/src',
  'apps/kortix-sandbox-agent-server/src',
  'apps/sandbox/entrypoint.sh',
  'packages/shared/src/sandbox',
] as const;

export interface ParsedGhcrImage {
  raw: string;
  registry: string;
  repository: string;
  tag: string;
  tagCommitPrefix: string | null;
}

export function parseGhcrImage(image: string): ParsedGhcrImage {
  const trimmed = image.trim();
  const withoutDigest = trimmed.split('@')[0] ?? trimmed;
  const colonIdx = withoutDigest.lastIndexOf(':');
  const refPart = colonIdx > withoutDigest.indexOf('/') ? withoutDigest.slice(0, colonIdx) : withoutDigest;
  const tag = colonIdx > withoutDigest.indexOf('/') ? withoutDigest.slice(colonIdx + 1) : 'latest';
  const slashIdx = refPart.indexOf('/');
  const registry = slashIdx > 0 ? refPart.slice(0, slashIdx) : 'ghcr.io';
  const repository = slashIdx > 0 ? refPart.slice(slashIdx + 1) : refPart;
  const shaMatch = tag.match(/^\d{8}-([0-9a-f]{7,40})(?:-|$)/i);
  return {
    raw: trimmed,
    registry,
    repository,
    tag,
    tagCommitPrefix: shaMatch?.[1]?.toLowerCase() ?? null,
  };
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function checkAnonymousGhcrPullable(parsed: ParsedGhcrImage): Promise<{
  ok: boolean;
  status: number | null;
  digest: string | null;
  error?: string;
}> {
  if (parsed.registry !== 'ghcr.io') {
    return { ok: true, status: null, digest: null };
  }
  try {
    const tokenRes = await fetch(
      `https://ghcr.io/token?scope=repository:${encodeURIComponent(parsed.repository)}:pull`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!tokenRes.ok) {
      return { ok: false, status: tokenRes.status, digest: null, error: `GHCR anonymous token returned HTTP ${tokenRes.status}` };
    }
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) {
      return { ok: false, status: tokenRes.status, digest: null, error: 'GHCR token response missing token' };
    }
    const manifestRes = await fetch(
      `https://ghcr.io/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.tag)}`,
      {
        method: 'HEAD',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: [
            'application/vnd.oci.image.index.v1+json',
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.v2+json',
          ].join(', '),
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    return {
      ok: manifestRes.ok,
      status: manifestRes.status,
      digest: manifestRes.headers.get('docker-content-digest'),
      ...(manifestRes.ok ? {} : { error: `GHCR manifest HEAD returned HTTP ${manifestRes.status}` }),
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      digest: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runDriftCheck(options: { strict?: boolean; skipNetwork?: boolean } = {}): Promise<{
  drifted: boolean;
  pullable: boolean;
  changedPaths: string[];
}> {
  const image = (process.env.KORTIX_SANDBOX_GHCR_IMAGE || FALLBACK_PINNED_SANDBOX_IMAGE).trim();
  const parsed = parseGhcrImage(image);
  const headSha = git(['rev-parse', '--short=8', 'HEAD']);
  const skillFiles = managedSkillOverlayFiles();
  const currentSkillsHash = managedSkillOverlayHash(skillFiles);

  const changedPaths: string[] = [];
  let commitFound = false;
  if (parsed.tagCommitPrefix) {
    const resolved = git(['rev-parse', '--verify', `${parsed.tagCommitPrefix}^{commit}`]);
    if (resolved) {
      commitFound = true;
      const diff = git(['diff', '--name-only', `${resolved}..HEAD`, '--', ...RUNTIME_PATHS]);
      if (diff) {
        changedPaths.push(...diff.split('\n').map((s) => s.trim()).filter(Boolean));
      }
    }
  }

  const ghcr = options.skipNetwork
    ? { ok: true, status: null, digest: null }
    : await checkAnonymousGhcrPullable(parsed);

  const drifted = (parsed.tagCommitPrefix !== null && headSha !== null && !headSha.startsWith(parsed.tagCommitPrefix) && changedPaths.length > 0) || !commitFound;

  const report = {
    pinned_image: parsed.raw,
    image_tag_commit: parsed.tagCommitPrefix,
    api_head_commit: headSha,
    expected_managed_skills_hash: currentSkillsHash,
    expected_managed_skills_count: skillFiles.length,
    ghcr_anonymous_pullable: ghcr.ok,
    ghcr_manifest_digest: ghcr.digest,
    runtime_paths_changed_since_image: changedPaths.length,
    sample_changed_paths: changedPaths.slice(0, 10),
    status: !ghcr.ok ? 'unpullable' : drifted ? 'version_drift_serving_ok' : 'aligned',
  };

  console.log('[sandbox-image-drift]', JSON.stringify(report, null, 2));

  if (!ghcr.ok) {
    console.error(`[sandbox-image-drift] ERROR: Pinned sandbox image is NOT anonymously pullable: ${ghcr.error ?? 'unknown'}`);
  } else if (drifted) {
    console.warn(
      `[sandbox-image-drift] WARN: Pinned image (${parsed.tag}) lags API HEAD (${headSha ?? 'unknown'}) across ${changedPaths.length} runtime file(s). ` +
      'Existing sandboxes remain usable via staleRuntimeMayServe. To publish a matching image, run:\n' +
      '  gh workflow run publish-kortix-sandbox-image.yml --repo MMUU6699/CompanyOS --ref dev',
    );
  }

  return { drifted, pullable: ghcr.ok, changedPaths };
}

if (import.meta.main) {
  const strict = process.argv.includes('--strict');
  const skipNetwork = process.argv.includes('--offline');
  const res = await runDriftCheck({ strict, skipNetwork });
  if (!res.pullable || (strict && res.drifted)) {
    process.exit(1);
  }
}
