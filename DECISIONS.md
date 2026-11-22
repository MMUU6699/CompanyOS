# Architectural Decisions & Audit Map (`DECISIONS.md`)

**Mission**: Re-architect Kortix (`CompanyOS`) onto Supabase (`kortix`), Daytona sandboxes, Railway backend hosting, hardcoded single-provider LLM inference (**NVIDIA NIM `google/gemma-4-31b-it`** with `chat_template_kwargs.enable_thinking: true`), Android Release APK (`apps/mobile`), and Netlify web deployment (`apps/web`).

---

## 1. Final Production Topology

| Layer | Live Endpoint / Artifact | Notes |
|---|---|---|
| Backend API + In-Process LLM Gateway | `https://kortix-api-production-20b48504.up.railway.app` | Single Railway container (`apps/api/Dockerfile`); serves `/health`, `/v1/*`, `/v1/llm/*`, `/v1/llm-gateway/*` |
| Database, Auth & Storage | `https://qeqfblzxfofaynevchbd.supabase.co` (`kortix`, `eu-central-1`) | 663/663 migrations, `kortix_app BYPASSRLS`, auto-confirm + workspace bootstrap triggers |
| Sandboxes | Daytona Cloud (`eu`, `https://app.daytona.io/api`) | Active full snapshots `kortix-default-e9cc19c4f2bb` (6.05 GB) and `kortix-mykortix-prod-3e463753d3080025` (6.00 GB) |
| Default Workspace Starter Repo | `https://github.com/MMUU6699/kortix-starter-workspace` (`main`) | Public manifest repo (`kortix.yaml`, `agents/worker.md`, `memory/MEMORY.md`) so new workspaces chat immediately without GitHub App installation |
| LLM Provider (Hard-Locked) | NVIDIA NIM `google/gemma-4-31b-it` (`enable_thinking: true`) | Zero model/provider picker UI; all model/BYOK/OAuth mutation APIs locked (`403`) |
| Web Frontend | `https://kortix-computer-app.netlify.app` | Netlify Next.js 16.4.2 SSR + Edge Middleware (`@netlify/plugin-nextjs@5.16.8`, deploy `6aff72fcb9df0df451273d4e`) |
| Android Mobile APK | `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` | `arm64-v8a` Release APK (`85.42 MB`, `com.kortix.application` v1.6.44, V2 signed) |

---

## 2. Key Architectural Decisions

### Decision 1: Single-Model Hard Lock — NVIDIA NIM `google/gemma-4-31b-it`
- **Single Source of Truth**: `apps/api/src/llm-gateway/resolution/nvidia-locked.ts` locks all gateway resolution, defaults, routing, and catalogs exclusively to `google/gemma-4-31b-it` (`provider: kortix`, upstream `nvidia` at `https://integrate.api.nvidia.com/v1`).
- **Wire Enforcement**: `packages/llm-gateway/src/http/call-upstream.ts` enforces NVIDIA NIM headers (`Accept: text/event-stream` / `application/json`, `Authorization: Bearer`) and payload (`model: "google/gemma-4-31b-it"`, `max_tokens`, `temperature: 1`, `top_p: 0.95`, `frequency_penalty: 0`, `presence_penalty: 0`, `seed: 0`, `chat_template_kwargs: { enable_thinking: true }`).
- **Timeout Floor**: `packages/llm-gateway/src/pipeline/dispatch.ts` sets `upstreamHeadersTimeoutMs` floor to `180_000 ms` for `nvidia` descriptors to accommodate thinking latency.
- **Route & UI Locks**: Provider/model switching, BYOK, custom provider, and OAuth endpoints return `403 model_selection_locked`. All model/provider picker components and settings routes were stripped from `@kortix/ui`, `apps/web`, and `apps/mobile`.

### Decision 2: In-Process LLM Gateway Mode Inside `apps/api`
- `apps/api/src/llm-gateway/wire.ts` mounts `createGateway()` in-process when `LLM_GATEWAY_PROXY_TARGET` is unset, removing the need for a separate Railway service and eliminating inter-service latency.

### Decision 3: Supabase `kortix_app` RLS Bypass & Zero-Friction Workspace Bootstrap
- **Why**: PostgreSQL does not inherit `BYPASSRLS` from role membership (`GRANT service_role TO kortix_app` was insufficient). Because `auth.sessions` and `auth.users` have RLS enabled, `confirmJwtLive` read 0 rows and failed every authenticated API request with `401 Invalid or expired token` (`jwt_session-not-live`).
- **Resolution**: Executed `ALTER ROLE kortix_app BYPASSRLS` on Supabase `kortix`.
- **Workspace Bootstrap**: Because managed GitHub App provisioning is unconfigured on self-hosted Railway (`GET /v1/projects/managed-git/status` -> `configured: false`), installed `trg_kortix_auto_confirm_user`, `trg_kortix_auth_user_bootstrap`, and `trg_kortix_account_bootstrap` (`kortix.ensure_account_workspace_and_billing`) to auto-confirm email signups and provision an `active` workspace backed by `https://github.com/MMUU6699/kortix-starter-workspace` (`main`, `kortix.yaml`), plus updated `apps/api/src/billing/services/account-state.ts` so `model_access` honors `KORTIX_BILLING_INTERNAL_ENABLED=false`.

### Decision 4: Daytona Snapshot Lifecycle & Removal of Bare `kortix-sandbox-v1`
- **Why**: `apps/api/src/snapshots/runtime-images.ts` falls back to `kortix-sandbox-v1` whenever that snapshot name exists in Daytona and a new `mykortix` image is still building. The initial `0.19 GB` bare image named `kortix-sandbox-v1` ran `sleep infinity` without `kortixd`, causing `"the session's machine could not be reached"`.
- **Resolution**: Deleted bare `kortix-sandbox-v1` from Daytona; Railway built and activated full `6+ GB` runtime snapshots `kortix-default-e9cc19c4f2bb` and `kortix-mykortix-prod-3e463753d3080025` with `/usr/local/bin/kortix-entrypoint`.

### Decision 5: Netlify Next.js 16 Monorepo Deployment Fixes
1. **Standalone Output Required**: `@netlify/plugin-nextjs@5.16.8` (OpenNext) requires `output: 'standalone'`; restored standalone output for Netlify in `apps/web/next.config.ts`.
2. **Monorepo Edge Middleware Path**: Removed `base = "apps/web"` from root `netlify.toml` while keeping `publish = "apps/web/.next"` and `--filter Kortix-Computer-Frontend`. Combining both doubled `apps/web/apps/web/.netlify/edge-functions-dist` and skipped uploading `___netlify-edge-handler-middleware`.
3. **Windows Path Bug in `@netlify/plugin-nextjs@5.16.8`**: On Windows hosts, `plugin-context.js` and `functions/server.js` emitted Windows backslashes (`\var\task\apps\web`) inside ESM imports in `___netlify-server-handler.mjs`, causing AWS Lambda `502 ERR_MODULE_NOT_FOUND`. Patched local plugin copy to emit POSIX relative imports (`./apps/web/.netlify/dist/run/handlers/...`) alongside `process.chdir('/var/task/apps/web')`. Linux CI builds are unaffected because `path.join` already emits POSIX `/`.
4. **Windows Build Memory Isolation**: Next.js Turbopack (`KORTIX_BUILD_CPUS=1`, `NODE_OPTIONS=--max-old-space-size=4096`) and Android Gradle CMake (`--max-workers=1`, `CMAKE_BUILD_PARALLEL_LEVEL=1`) must run sequentially on 16 GB Windows hosts to avoid OOM.

### Decision 6: Android Release Build (`apps/mobile`) Configuration
- Removed upstream `EXPO_UPDATE_URL` (`u.expo.dev`) and legacy `kortix.com` intent filters from `apps/mobile/android/app/src/main/AndroidManifest.xml`, `apps/mobile/app.json`, `apps/mobile/lib/auth/web-registration-handoff.ts`, and `apps/mobile/lib/share-link.ts`; wired `kortix://`, `exp+kortix://`, and `https://kortix-computer-app.netlify.app` (`/auth`, `/share`, `/invites`).
- Updated `apps/mobile/lib/auth/mobile-admission.ts` so new mobile Google OAuth sessions are admitted cleanly.
- Pinned `reactNativeArchitectures=arm64-v8a` in `apps/mobile/android/gradle.properties` and resolved `react-native-keyboard-controller` stale Java/JNI codegen conflict under `node_modules`.

---

## 3. Secret Hygiene Verification
- Plaintext secrets (`NVIDIA_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DAYTONA_API_KEY`, `DATABASE_URL`, `API_KEY_SECRET`, `INTERNAL_SERVICE_KEY`, `GATEWAY_INTERNAL_TOKEN`, `TUNNEL_SIGNING_SECRET`) exist **only** in Railway service environment variables (never in tracked repo files, Netlify public env, `PROGRESS.md`, `DECISIONS.md`, or the Android APK bundle).
- Inspected `assets/index.android.bundle` inside `app-release.apk`: confirmed `False` for `nvapi-`, `service_role`, `dtn_`, `SUPABASE_SERVICE_ROLE_KEY`, `DAYTONA_API_KEY`, and `api.kortix.com`.

---

## 4. Modified Repository Files Summary
- **Backend / Gateway**: `packages/llm-gateway/src/http/call-upstream.ts`, `packages/llm-gateway/src/pipeline/dispatch.ts`, `apps/api/src/config.ts`, `apps/api/src/llm-gateway/resolution/nvidia-locked.ts`, `apps/api/src/llm-gateway/resolution/{resolve-candidates,default-model}.ts`, `apps/api/src/llm-gateway/routing/index.ts`, `apps/api/src/llm-gateway/models/{servable-catalog,catalog-models,served-managed-models}.ts`, `apps/api/src/llm-gateway/wire.ts`, `apps/api/src/projects/routes/{models,custom-providers,gateway-providers,claude-subscription,provider-oauth,provider-secret-pools}.ts`, `apps/api/src/billing/services/account-state.ts`, `apps/api/Dockerfile`, `railway.json`.
- **Web / UI**: `netlify.toml`, `apps/web/next.config.ts`, `apps/web/src/app/[locale]/(auth)/auth/page.tsx`, `apps/web/src/components/kortix-ui-provider.tsx`, `apps/web/src/lib/menu-registry.ts`, `apps/web/scripts/{viewer-wasm,emojibase-data,blume-docs}.mjs`, `packages/shared/src/workspace-settings.ts`, `packages/ui/src/providers/ui-provider.tsx`, `packages/ui/src/session/models/*`, `packages/ui/src/customize/*`, `packages/ui/src/workspace/admin/project-admin-dashboard.tsx`.
- **Mobile**: `apps/mobile/android/app/src/main/AndroidManifest.xml`, `apps/mobile/android/gradle.properties`, `apps/mobile/app.json`, `apps/mobile/lib/deployment/deployment.ts`, `apps/mobile/lib/kortix-web.ts`, `apps/mobile/lib/auth/{mobile-admission,web-registration-handoff}.ts`, `apps/mobile/lib/share-link.ts`, `apps/mobile/components/session/{ModelPickerSheet,ConnectProviderSheet,ProjectHome,SessionChatInput,SessionPage}.tsx`, `apps/mobile/components/pages/{TriggerAgentModelFields,ScheduleSheets}.tsx`.

---

## 5. Remaining Manual Google OAuth & Supabase Auth Dashboard Checklist
Because this session does not have `invoke_subagent` in its tool schema to operate authenticated IDE browser tabs, complete these two dashboard steps directly in the open tabs:

1. **Google Cloud Console -> Google Auth Platform (`https://console.cloud.google.com/auth/overview`)**:
   - **Branding -> App name**: `Kortix` (zero random strings/IDs).
   - **Branding -> Authorized domains**: `netlify.app`, `supabase.co`, `up.railway.app`.
   - **Clients -> Create OAuth 2.0 Client ID (Web application)**:
     - Authorized JavaScript origins:
       - `https://kortix-computer-app.netlify.app`
       - `https://kortix-api-production-20b48504.up.railway.app`
     - Authorized redirect URIs:
       - `https://qeqfblzxfofaynevchbd.supabase.co/auth/v1/callback`
   - **Important Google Consent Screen Branding Note**: Even with App Name set to `Kortix`, Google's consent screen displays the redirect callback domain (`qeqfblzxfofaynevchbd.supabase.co`) when using Supabase's default domain (`Sign in to continue to qeqfblzxfofaynevchbd.supabase.co`). Displaying your own domain (`auth.yourdomain.com`) instead of `qeqfblzxfofaynevchbd.supabase.co` requires enabling a **Supabase Custom Domain** (Pro add-on) + verifying the Google OAuth app. Setting App Name = `Kortix` ensures the app title itself is `Kortix` rather than any random project identifier.
2. **Supabase Dashboard (`qeqfblzxfofaynevchbd`)**:
   - **Authentication -> Providers -> Google**: Enable Google, paste the Web Client ID and Client Secret from Step 1, and Save.
   - **Authentication -> URL Configuration**:
     - **Site URL**: `https://kortix-computer-app.netlify.app`
     - **Redirect URLs** (add all):
       - `https://kortix-computer-app.netlify.app/**`
       - `https://kortix-computer-app.netlify.app/auth/callback`
       - `https://kortix-computer-app.netlify.app/auth/mobile/callback`
       - `kortix://**`
       - `exp+kortix://**`
   - After saving, verify `GET https://qeqfblzxfofaynevchbd.supabase.co/auth/v1/settings` returns `"google": true`.

---

## 6. Cloud-Controlled Free OpenRouter Failover, Daytona LRU Quotas & Mobile-Only Distribution (Decisions 7–9)

### Decision 7: Cloud Hot-Swappable 100% Free OpenRouter Chain & 1-Failure Circuit Breaker
- **Superseded Decision 1 (NVIDIA single-model lock)**: Switched managed inference to an OpenRouter 100% free-only fallback chain (`:free` + `openrouter/free` enforced by `assertFreeOpenRouterModelId` / `isAllowedFreeOpenRouterModelId`).
- **Cloud Control Plane (`kortix.runtime_config` + `OPENROUTER_FREE_MODELS`)**: To change or reorder models for both Web and existing installed APKs without rebuilding clients, update row `key = 'openrouter_free_models'` in Supabase `kortix.runtime_config` (takes effect globally within the `30_000 ms` TTL of `refreshOpenRouterFreeChainIfStale()`) or update `OPENROUTER_FREE_MODELS` in Railway env vars.
- **Fast Failover**: Configured `openRouterFreeBreakers` (`consecutiveFailures: 1`, `cooldownMs: 300_000`, `maxCooldownMs: 600_000`), `tripsOpenRouterBreaker` (`404`/`408`/`409`/`425`/`429`/`5xx`/timeout), and `OPENROUTER_FIRST_TOKEN_TIMEOUT_MS` (`15_000` ms).

### Decision 8: Daytona Tier-1 Proactive LRU Slot Manager (`managed` Sandboxes Only)
- Tier-1 Daytona `eu` quotas allow `10 GiB` RAM and `30 GiB` active disk (`2 vCPU / 4 GiB RAM / 10 GiB disk` per default Kortix sandbox), with `9 GiB` reserved by 3 pre-existing unrelated `build-x` `error` sandboxes (`4c6e7026`, `8167c4a6`, `a2d9eeba`, `2026-09-27`, kept untouched).
- `ensureDaytonaCapacitySlot` and `reclaimDaytonaDiskSlots` filter strictly on `sb.managed` (`labels['kortix.managed']`) and enforce `KORTIX_DAYTONA_MAX_RUNNING_SANDBOXES=2` and `KORTIX_DAYTONA_MAX_NON_ARCHIVED_SANDBOXES=2` alongside idle auto-stop (`5m`) and auto-archive (`5m`).

### Decision 9: Mobile-Only Distribution & Direct Android APK Hosting
- Replaced all desktop installer flows and App Store / Google Play badges across `apps/web` and `packages/ui` with a direct Android APK download (`kortix-latest.apk`, `89,572,194` bytes, hosted on public GitHub Release `MMUU6699/kortix-starter-workspace` tag `android-latest` due to Supabase Storage's 50 MB free-tier upload cap) plus a non-clickable `Coming Soon` / `قريباً` iOS badge.
- Redirected `/desktop` -> `/download` and routed `/download/[platform]` strictly to `DIRECT_ANDROID_APK_URL` (`android` / Android QR scan) or `/download` (all others).
- **Pre-Commit Hook Note on Windows**: Restoring `apps/web/translations/en.json` avoided CRLF drift against `apps/web/scripts/i18n-catalogs.mjs` across unrelated locales; `packages/ui/dist/styles.css` was rebuilt directly with `tailwindcss.cmd` (`gen-i18n-catalog.mjs --check` exits `0`).

### Decision 10: Unified 9-Model Free Multi-Provider Chain (NVIDIA NIM + OpenRouter `:free`), Vision-Aware Routing & `Mykortix` Inline Execution
- **Why**: OpenRouter enforces a `50 requests/day` cap across all `:free` models combined for `$0`-balance accounts (`X-RateLimit-Limit: 50`), which caused agentic multi-step tasks and parallel sub-agents spawned by `Mykortix` to exhaust the daily quota and enter `kortixd` `429 model_busy` retry backoff loops (`Attempt 8 · Retrying in 190s`).
- **Resolution (Cloud-Only, Zero APK Rebuild)**:
  1. Combined 5 live-benchmarked free NVIDIA NIM models (`nvidia/nemotron-3.5-super-vl-120b-a12b`, `stepfun-ai/step-5-preview`, `minimaxai/minimax-m3.1-flash`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `nvidia/nemotron-3-ultra-550b-a55b` with `enable_thinking: false` and `max_tokens: 4096..8192`) ahead of 4 OpenRouter `:free` models (`nvidia/nemotron-3.5-super-vl:free`, `nvidia/nemotron-3.5-lightning:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `openrouter/free`) in Supabase `kortix.runtime_config` (`key = 'openrouter_free_models'`) and Railway `OPENROUTER_FREE_MODELS`.
  2. Added `openRouterFreeChainForRequest({ requiresVision })` in `apps/api/src/llm-gateway/resolution/openrouter-free.ts` so requests with `input.requires.imageInput === true` (`image_url`) route exclusively through Vision-capable free models.
  3. Updated `MY_KORTIX_PROMPT` (`apps/api/src/projects/lib/my-kortix-prompt.ts`) so `Mykortix` executes single-session web search, URL visits, file creation, and HTML/CSS/JS website builds inline in `/workspace` instead of spawning multiple `General` sub-agent sessions via `agent`.
  4. Added `(usage limit reached)` to the gateway's final `429 model_busy` message (`packages/llm-gateway/src/pipeline/public-identity.ts`) so `kortixd`'s `PERMANENT` error classifier stops retrying immediately after all 9 free tiers are exhausted, and removed `"or choose another model"` from error suggestions.

---

## 9. Phase 9 Decisions — `prompt-attachments` Storage Auth, v2 Session-Log Optimistic Deduplication & `Mykortix` Tool/Browser Architecture (2026-11-21)

- **Supabase Storage Service-Role Authentication (`prompt-attachments`)**:
  - `apps/api/src/projects/prompt-attachment-storage.ts` authenticates against Supabase Storage bucket `staged-files` using `config.SUPABASE_SERVICE_ROLE_KEY` after `kortix-api` has already validated the user's JWT and workspace membership. Fixed Railway's `SUPABASE_SERVICE_ROLE_KEY` from the `anon` key to the project's `service_role` key so server-side attachment staging succeeds (`HTTP 201` / `HTTP 200`) without weakening RLS policies on `storage.objects`.
- **v2 Session-Log (`kortix.session/2`) Optimistic User Message Retirement & Queue Filtering**:
  - Added `retireOptimisticUsersForSessionLog()` in `packages/sdk/src/browser/stores/sync-store.ts` so `applySessionLogPage()`, `applySessionLogFrame()`, and `registerOptimisticEcho()` atomically retire v1 optimistic user rows in `state.messages[threadId]` when confirmed by exact ID, registered re-mint alias (`optimisticEchoes`), or dispatched non-inbox-backed first-prompt seed (`markSeededPrompt`).
  - Wired `openSessionStream.onConnectionChange` in `packages/sdk/src/react/use-runtime-events/connect-stream.ts` to emit `open` / `lost` on `subscribeRuntimeStream` so idle or fast-completing R5.3 sessions do not stay in `phase: 'connecting'` and trigger a false `Live updates paused · Reconnect` banner after `120 s`.
  - Added `filterVisibleQueuePrompts()` in `apps/mobile/lib/session/queue-undo.ts` and echo registration in `apps/mobile/components/session/SessionPage.tsx` so `QueuePanel` (`Up next`) excludes initial prompts and messages already rendered in the transcript.
- **`Mykortix` Tools & Interactive Desktop/Browser Architecture**:
  - `Mykortix` builds from `PLATFORM_DEFAULT_USER_DOCKERFILE` + `kortixToolchainLayer` (`packages/shared/src/sandbox/my-kortix-dockerfile.ts`), which bakes Chromium, Playwright, `agent-browser`, Xvfb (`DISPLAY=:1`), XFCE, and `voxl` live H.264 desktop streaming on port `6901` (`packages/shared/src/sandbox/desktop.ts`, `apps/sandbox/entrypoint.sh`).
  - Browser automation inside the sandbox is driven via the `agent-browser` CLI or Playwright through `bash` (there are no separate `browser_navigate` / `browser_click` LLM tool schemas). Note that managed router tools `web_search` (`TAVILY_API_KEY`), `scrape_webpage` (`FIRECRAWL_API_KEY`), and `image_search` (`SERPER_API_KEY`) require their upstream keys on Railway unless the agent uses `bash` (`curl` / `agent-browser` / Python).
  - Web (`packages/ui/src/session/panel/session-desktop.tsx`) includes the interactive `SessionDesktop` live screen viewer (port `6901` with Take over / Return control), whereas Mobile (`apps/mobile`) provides `SandboxPreviewSheet` and `BrowserPage` (authenticated WebView for sandbox ports/files) and does not yet mount a dedicated port-`6901` `SessionDesktop` control bar.

---

## 10. Phase 10 Decisions — Cross-Site Desktop Streaming (`:6901`), Daytona X11 Self-Heal & Tier 1/2 Egress Policy (2026-11-21)

- **Cross-Site Path-Preview CHIPS Cookies (`__preview_session` + `__preview_session_chips`)**:
  - When `KORTIX_PREVIEW_BASE_DOMAIN` is unset and web (`*.netlify.app`) frames sandbox previews on the API host (`*.up.railway.app`), `SameSite=Lax` cookies are never sent cross-site. Over HTTPS, `/v1/p/auth` and `setPreviewSessionCookie` now emit both `__preview_session` (`SameSite=None; Secure`, for top-level tabs) and `__preview_session_chips` (`SameSite=None; Secure; Partitioned`, for cross-site iframes/probes), keeping `SameSite=Lax` over plain `http://localhost`. Both cookie names are enforced by `cookie-csrf.ts` and stripped from upstream app requests (`preview-session.ts`, `public-proxy-headers.ts`, `preview-response.ts`).
  - Added `'HEAD'` to `Access-Control-Allow-Methods` in `apps/api/src/middleware/cors.ts` so authenticated `HEAD` pre-auth probes pass CORS preflight.
- **Cookie-Authenticated Path-Form Preview WebSockets + Origin CSRF Guard**:
  - `preparePreviewWsUpgrade(url, req)` accepts `__preview_session_chips` / `__preview_session` cookies (needed by `voxl`'s `wss://.../v1/p/<sandbox>/6901/ws` client) and enforces `isPreviewPathWsOriginAllowed(req, url)`: ambient-cookie upgrades are accepted only when `Origin` matches the API host itself (the framed `voxl` worker) or the allowlisted `FRONTEND_URL`, rejecting third-party origins with `HTTP 403`.
- **Dedicated `'desktop'` Frame Sandbox Policy (`packages/ui/src/files/viewer/preview-policy.ts`)**:
  - Kept agent-authored `'document'`, `'app'`, and `'slide'` frames opaque on privileged origins, while adding `'desktop'` for Kortix's first-party `voxl` streamer on `/v1/p/<sandbox>/6901/` when hosted on a distinct API origin (never same-origin with the web app), enabling `voxl`'s same-origin WebCodecs `Worker` and WebSocket cookie attachment.
- **Daytona Stop/Resume Stale `/tmp/.X1-lock` Repair**:
  - Fixed `apps/sandbox/entrypoint.sh` to remove stale `/tmp/.X<N>-lock` and `/tmp/.X11-unix/X<N>` before starting `Xvfb` and to self-heal `Xvfb` inside the desktop supervisor loop. Added throttled single-flight `repairDaytonaDesktopIfStale()` in `apps/api/src/platform/providers/daytona.ts` (invoked on Daytona resume and first port-`6901` `502` in `retry.ts`) so existing sandboxes recover automatically.
- **Daytona Tier 1/2 Container Egress Boundary (No Bypass)**:
  - Live container diagnostics confirmed Daytona's Envoy firewall returns `HTTP 403: Internet is restricted on Tier 1 and Tier 2.` for non-allowlisted outbound public sites while permitting `http://localhost:*`, `github.com`, `registry.npmjs.org`, `pypi.org`, and the Railway API. Rather than bypassing Daytona's tier restriction, `MY_KORTIX_PROMPT` instructs `Mykortix` to run headed `agent-browser` on `DISPLAY=:1` for local/allowlisted sites and fail fast after 1 attempt on restricted public domains, immediately falling back to `scrape_webpage` / `web_search` (and noting that Daytona Tier 3+ unlocks full outbound container browsing).

---

## 11. Phase 11 Decisions — Per-User Multi-Tenant Daytona Onboarding, `defaultRegionId` Auto-Setup & Tier 1 Proxy (2026-11-21)

- **WorkOS Device Authorization Flow + Permanent Org API Key**:
  - Daytona (`v0.234.2`) publishes its public WorkOS CLI client (`oidc.cli.clientId`) at `GET /api/config` and supports RFC 8628 Device Authorization Flow (`POST /user_management/authorize/device`) without requiring a `localhost` redirect callback. `apps/api/src/onboarding/daytona-service.ts` discovers OIDC endpoints dynamically (15-min cache), polls until approved, uses the ephemeral WorkOS JWT solely to resolve the personal org (with a 6-attempt propagation retry for brand-new accounts), configure `defaultRegionId`, and mint a permanent `dtn_...` key via `POST /api/api-keys` (scoped to `write:sandboxes`, `delete:sandboxes`, `write:snapshots`, `delete:snapshots`, `read:limits`, `expiresAt: null`), then encrypts the key with AES-256-GCM + HKDF-SHA256 (`daytona-crypto.ts`) and discards the JWT immediately.
- **Verified Daytona Region Provisioning (`GET /shared-regions` + `PATCH /organizations/:orgId/default-region`)**:
  - Brand-new Daytona personal organizations start with `defaultRegionId = null`, causing `POST /api/snapshots` to fail with `HTTP 400 DefaultRegionRequiredException`. Audited `@daytona/api-client@0.184.0`: shared regions are listed at `GET /shared-regions` (not `/regions`), and updating an organization's default region uses `PATCH /organizations/{organizationId}/default-region` with `{ defaultRegionId }` (not `PUT`). `ensureDefaultRegionOnOrg` enforces `PATCH` while holding the WorkOS JWT; `ensureUserSnapshot` attempts a self-heal `PATCH` for pre-existing orgs and otherwise returns structured `DAYTONA_REGION_REQUIRED` (`reconnectRequired: true`) so a single **Reconnect Daytona** flow resolves it cleanly.
- **Public Pinned GHCR Snapshot Distribution**:
  - Rather than rebuilding the `~6 GB` sandbox Dockerfile inside each user's Daytona org (10+ min per user), `.github/workflows/publish-kortix-sandbox-image.yml` publishes an immutable tagged image to public GHCR (`ghcr.io/mmuu6699/kortix-sandbox:20261121-da3f5cdd`). Each user's Daytona org pulls that image once (`~30–60s`) with explicit `entrypoint: ["/usr/local/bin/kortix-entrypoint"]`, `cpu: 2`, `memory: 4`, `disk: 10`, `sandboxClass: "container"`. `ensureUserSnapshot` handles `inactive` auto-activation (after Daytona's 14-day inactivity window) and errored snapshot cleanup automatically.
- **Org-Partitioned Concurrency & Strict Secret/Error Hygiene**:
  - `compute-quota-guard.ts` partitions in-flight compute/disk/capacity single-flight maps by `daytonaOrgId` so users never block or evict each other's sandboxes.
  - All Daytona onboarding failures map to structured codes (`DAYTONA_REGION_REQUIRED`, `DAYTONA_EMAIL_UNVERIFIED`, `DAYTONA_QUOTA_EXCEEDED`, `DAYTONA_SNAPSHOT_FAILED`, `DAYTONA_RECONNECT_REQUIRED`, `DAYTONA_TIMEOUT`) with human-readable copy on server and client; raw upstream JSON is logged server-side only and never rendered in Web or Mobile UI.
  - Mobile always opens Daytona Device Flow via `WebBrowser.openBrowserAsync` (Chrome Custom Tabs on Android / Safari View Controller on iOS, never a `WebView`) and persists both active `flowId` and `claimToken` in `AsyncStorage` across Android activity restarts.
- **Tier 1 Railway Open-Web Search & Scrape Fallback (`$0.00`)**:
  - When `TAVILY_API_KEY` / `FIRECRAWL_API_KEY` are unset, `apps/api/src/router/routes/proxy/open-web-fallback.ts` serves `/v1/router/tavily/search` (DuckDuckGo HTML/Lite + Google News RSS + Bing RSS + Wikipedia OpenSearch) and `/v1/router/firecrawl/v2/scrape` (HTML-to-Markdown guarded by `assertSafeEgressUrl` SSRF checks), giving Tier 1 Daytona sandboxes full web search and webpage reading at `$0.00` without bypassing Daytona's container egress boundary.

---

## 12. Phase 12 Decisions — Warm Per-User Daytona Lifecycle, 120s Wake-Cliff Removal & Non-Blocking Background Snapshot Pull (2026-11-22)

- **Per-User Warm Stop (15m/30m) & 24h Auto-Archive (`1440m`) Policy**:
  - Previously, Daytona `autoStopInterval` and `autoArchiveInterval` were clamped to `5m`, archiving idle sandboxes within 10 minutes and forcing `20–60s` cold image restores on return. Per-user orgs now run `KORTIX_SANDBOX_AUTOSTOP_MINUTES=15` (Kortix idle grace), Daytona `autoStopInterval=30m` backstop, `KORTIX_SANDBOX_AUTOARCHIVE_MINUTES=1440` (24h, clamped up to `4320m`), `maxRunning=2`, and `maxNonArchived=3` (utilizing a clean Tier 1 org's `30 GiB` = `3 × 10 GiB` disk budget; legacy global org remains capped at `maxNonArchived=2`). Daily chats stay in warm `stopped` state (`2–5s` resume).
- **Skip Disk Eviction on Warm `stopped` Resume & Eliminate the 120s Wake Cliff**:
  - Added `skipDiskEviction?: boolean` to `ensureDaytonaCapacitySlot()` (`apps/api/src/projects/compute-quota-guard.ts`): waking an already-`stopped` sandbox keeps its existing `10 GiB` disk slot and skips `listStopped()` and LRU archival completely.
  - Added `'starting'` to `SandboxStatus` (`apps/api/src/platform/providers/status.ts`) and mapped Daytona `'starting' | 'restoring' | 'pending_start'` to `'starting'` (`daytona-state.ts`) instead of `'running'`, preventing `waitForRuntimeWakeRunning` from declaring an archived/restoring sandbox running prematurely, tripping the `30s` unreachable deadline, and entering a `120s` failure cooldown. `DaytonaProvider.start()` now passes `90s` (`DAYTONA_START_TIMEOUT_MS`), skips blind timeout retries (`retryOnTimeout: false`), waits via `waitUntilStarted(90)` when already starting, and emits `opts.onProgress` heartbeats during archived restores.
- **Non-Blocking Background Snapshot Pull & Mobile Wake Parity**:
  - Both `/v1/onboarding/daytona/poll` and `saveManualDaytonaKey` return immediately after persisting the encrypted key and dispatch `ensureUserSnapshot` asynchronously via `setImmediate` (`65_000 ms` `POST /snapshots` timeout).
  - Web (`apps/web/src/features/auth/daytona-step.tsx`) and Mobile (`apps/mobile/components/auth/DaytonaOnboardingGate.tsx`) let connected users enter Chat/Home immediately with a subtle floating top pill banner while `snapshotStatus` is `'pending' | 'pulling' | 'inactive'`, reserving full-screen blocking UI strictly for unconnected accounts or `DAYTONA_REGION_REQUIRED` / `DAYTONA_RECONNECT_REQUIRED`. If a user sends early, `ensureUserSnapshotActive(..., { onPulling })` reports `boot.image = { state: 'waiting_for_provider' }` so Web and Mobile render inline image-preparation progress and launch automatically once active.
  - Web `handleStartDaytona` navigates the pre-opened blank tab via `popup.location.replace(verificationUriComplete)` before severing `popup.opener = null`, eliminating orphan `about:blank` tabs.
  - Mobile `useProjectSessionConnect` now passes `{ waitMs: 15_000 }` to `startProjectSession`, and `connectStepFromStart` requires `start.stage === 'ready'` before opening, eliminating the `15s` blocking `getSessionHealth` stall on waking sandboxes.
