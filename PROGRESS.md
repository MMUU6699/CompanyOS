# Execution Progress Log (`PROGRESS.md`)

**Mission**: Kortix (`CompanyOS`) Re-Architecture — Supabase (`kortix`) + Daytona + Railway + Exclusive NVIDIA NIM (`google/gemma-4-31b-it`) + Android Release APK + Netlify Web Deployment.

---

## Phase 1 — Deep Codebase Audit
- **Status**: `COMPLETED`
- **Verified Outputs**:
  - Audited backend (`apps/api`, `apps/llm-gateway`, `packages/llm-gateway`), database (`packages/db/drizzle/0000_bootstrap.sql` + 663 migrations in `packages/db/migrations/`), sandbox (`apps/api/src/platform/providers/daytona.ts`, `apps/api/src/snapshots/build-context.ts`, `apps/kortix-sandbox-agent-server`), web (`apps/web`, `packages/ui`, `packages/shared`), and mobile (`apps/mobile`, `apps/mobile/android/`).
  - Workspace dependencies installed cleanly (`pnpm install --frozen-lockfile`, 29 workspace projects, exit 0).
  - Documented full architectural map and modification plan in `DECISIONS.md`.

---

## Phase 2 — Cloud Infrastructure, Database & Sandbox Provisioning
- **Status**: `COMPLETED & VERIFIED LIVE`
- **Railway (`kortix-api`)**:
  - Live URL: `https://kortix-api-production-20b48504.up.railway.app`
  - `/health` verified `HTTP 200` (`status: ok`, `service: kortix-api`, `environment: prod`).
  - CORS preflight (`OPTIONS /v1/projects`, `Origin: https://kortix-computer-app.netlify.app`) verified `HTTP 204` with `access-control-allow-origin: https://kortix-computer-app.netlify.app` and `access-control-allow-credentials: true`.
  - In-process `@kortix/llm-gateway` live at `/v1/llm/v1/models` and `/v1/llm/v1/chat/completions`.
- **Supabase (`kortix` — `qeqfblzxfofaynevchbd`, `eu-central-1`)**:
  - Applied `packages/db/drizzle/0000_bootstrap.sql` and all **663 / 663** migrations (`289` tables, `9` views, `248` RLS-enabled tables, `14` storage buckets).
  - **Root-Cause Fix (Global 401s)**: Granted `ALTER ROLE kortix_app BYPASSRLS` (PostgreSQL does not inherit `BYPASSRLS` from `service_role` membership; `auth.sessions` and `auth.users` have RLS enabled, causing `confirmJwtLive` to return 0 rows with `jwt_session-not-live`). Verified all authenticated endpoints immediately moved from `401` to `200`.
  - **Root-Cause Fix (Zero-Friction Email Signup + Workspace Bootstrap)**: Installed `trg_kortix_auto_confirm_user`, `trg_kortix_auth_user_bootstrap`, and `trg_kortix_account_bootstrap` (`kortix.ensure_account_workspace_and_billing`) so new signups receive an active session immediately and an auto-provisioned `active` workspace pointing to public starter repository `https://github.com/MMUU6699/kortix-starter-workspace` (`main`, `kortix.yaml` + `agents/worker.md` + `memory/MEMORY.md`, `setup_complete_at` set, `enterprise_entitled = true`).
  - Live Supabase log audit (`supavisor_logs`, `edge_logs`, `auth_logs`, `postgrest_logs`, `storage_logs`) verified `0` runtime errors during end-to-end web and mobile flows.
- **Daytona (`eu`, `https://app.daytona.io/api`)**:
  - Railway automatically staged and built two full `ACTIVE` runtime snapshots with `/usr/local/bin/kortix-entrypoint`:
    - `kortix-default-e9cc19c4f2bb` (`6.05 GB`, `ACTIVE`)
    - `kortix-mykortix-prod-3e463753d3080025` (`6.00 GB`, `ACTIVE`)
  - **Root-Cause Fix**: Deleted the legacy `0.19 GB` bare `kortix-sandbox-v1` snapshot (`entrypoint: ["sleep", "infinity"]`, no `kortixd`) that `apps/api/src/snapshots/runtime-images.ts` fell back to during initial `mykortix` image builds, resolving `"the session's machine could not be reached"`.

---

## Phase 3 — Exclusive NVIDIA NIM (`google/gemma-4-31b-it`) Lock-In & UI Stripping
- **Status**: `COMPLETED & VERIFIED LIVE`
- **Live Gateway Proof**:
  - `GET /v1/llm/v1/models` returns `google/gemma-4-31b-it` (`Gemma 4 31B`, `reasoning: true`) as the sole model.
  - `POST /v1/llm/v1/chat/completions` requesting an override model with `stream: true` hard-locked to `google/gemma-4-31b-it` (`HTTP 200 text/event-stream`, 57 SSE lines, streamed `delta.reasoning_content` + `delta.content`, `reasoning_tokens: 49`). Temporary verification gateway key revoked after test.
- **UI Audit**:
  - Confirmed zero model picker, provider connect, or BYOK UI across both live web (`https://kortix-computer-app.netlify.app`) and mobile (`apps/mobile`).

---

## Phase 4 — Netlify Web App (`apps/web`)
- **Status**: `DEPLOYED & VERIFIED LIVE`
- **Production URL**: `https://kortix-computer-app.netlify.app` (Site ID `ecef4408-cc7c-458c-ad9c-673fbf59e2fe`, Live Deploy ID `6aff72fcb9df0df451273d4e`).
- **Fixes Applied & Verified**:
  1. Re-enabled `output: 'standalone'` in `apps/web/next.config.ts` (required by `@netlify/plugin-nextjs@5.16.8`).
  2. Defaulted `AUTH_PROVIDERS` to `google` in `apps/web/src/app/[locale]/(auth)/auth/page.tsx` and upserted all production `NEXT_PUBLIC_*` and `KORTIX_PUBLIC_*` env vars on Netlify (`BACKEND_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_URL`, `AUTH_PROVIDERS=google`, `AUTH_METHODS=password,magic`, `MANAGED_PROVIDER_ENABLED=true`, `BILLING_ENABLED=false`).
  3. Fixed `@netlify/plugin-nextjs@5.16.8` Windows path separator bug (`plugin-context.js`, `functions/server.js`, `handler-monorepo.tmpl.js`) that emitted `\var\task\apps\web` backslashes and caused `502 ERR_MODULE_NOT_FOUND` on AWS Lambda.
  4. Removed duplicate `base = "apps/web"` from root `netlify.toml` (when used with `--filter Kortix-Computer-Frontend`, it doubled the `.netlify/edge-functions-dist` path and skipped uploading `___netlify-edge-handler-middleware`, causing `/` and `/auth` to return Next.js `404`).
- **Live Browser E2E Proof (Headless Chromium against `https://kortix-computer-app.netlify.app`)**:
  - `/` -> `HTTP 200`, `/auth` -> `HTTP 200` (`Continue with Google` + Email/Password visible), `/workspaces` -> redirects to `/auth?redirect=%2Fworkspaces`, `/api/health` -> `HTTP 200`, `/api/runtime-config` -> `HTTP 200` with live Railway + Supabase URLs.
  - Brand-new synthetic Email + Password login succeeded and redirected to `/workspaces/<id>` with `0` console errors, `0` failed requests, `0` CORS blocks, and `HTTP 200` across all Railway API endpoints.
  - Submitting a live session booted a real Daytona sandbox (`STARTED`, `eu`, port `8000` proxied `HTTP 200` via Railway), streamed NVIDIA `google/gemma-4-31b-it` reasoning + interactive tool UI directly in the browser, and persisted 7 messages into Supabase `kortix.session_log_messages`.

---

## Phase 5 — Android Release APK (`apps/mobile`)
- **Status**: `BUILT & VERIFIED ON DISK`
- **Final APK Artifact**:
  - Path: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
  - Size: `89,570,286` bytes (`85.42 MB`)
  - SHA-256: `EE196704C50677B5DDA5A8970993235B69C817FB6018D464CA396670DF7C584A`
  - Package: `com.kortix.application`, `versionName=1.6.44`, `minSdk=24`, `targetSdk=36`, ABI: `arm64-v8a`, valid V2 APK signature.
- **Verified Embedded Config & Security Audit**:
  - `assets/index.android.bundle` (`19,412,492` bytes) verified to contain live Railway (`kortix-api-production-20b48504.up.railway.app/v1`), live Supabase (`qeqfblzxfofaynevchbd.supabase.co`), live Netlify (`kortix-computer-app.netlify.app`), and public Supabase anon key.
  - Confirmed `False` (absent) for `api.kortix.com`, `nvapi-`, `service_role`, `dtn_`, `SUPABASE_SERVICE_ROLE_KEY`, and `DAYTONA_API_KEY`.
  - `aapt2 dump xmltree AndroidManifest.xml` confirmed `EXPO_UPDATES_CHECK_ON_LAUNCH=NEVER`, zero `EXPO_UPDATE_URL`, deep links `kortix://`, `exp+kortix://`, and HTTPS app links on `kortix-computer-app.netlify.app` (`/auth`, `/share`, `/invites`).
- **Live Mobile-to-Backend E2E Proof**:
  - Verified exact mobile client headers (`X-Kortix-Client: mobile`, `X-Kortix-Client-Version: 1.6.44`) against `GET /v1/auth/client-config`, Supabase GoTrue password grant, `GET /v1/workspaces`, `GET /v1/projects/:id/sessions`, and real Daytona bash tool execution (`pwd && echo KORTIX_MOBILE_E2E_OK`) via Gemma 4 31B.

---

## Phase 6 — Remaining Manual Dashboard Action (Google OAuth + Supabase Auth URLs)
- **Status**: `PENDING USER DASHBOARD ACTION (TOOLSET LIMITATION)`
- **Exact Reason**: This agent session's tool schema does not include `invoke_subagent` (no programmatic access to the IDE's built-in authenticated browser tabs), and opening an external browser window is prohibited.
- **Verified Live State (`GET https://qeqfblzxfofaynevchbd.supabase.co/auth/v1/settings`)**:
  - `external.email`: `true` (working live end-to-end on Web + Mobile).
  - `external.google`: `false` (requires enabling in Google Cloud Console + Supabase Dashboard; exact values documented in `DECISIONS.md` Section 5).

---

## Phase 7 — Cloud-Controlled Free OpenRouter Failover, Daytona LRU Concurrency, Direct APK Hosting & Mobile-Only Web Overhaul
- **Status**: `COMPLETED & VERIFIED LIVE`
- **Cloud-Controlled 100% Free Multi-Model System (`apps/api`, `@kortix/llm-gateway`, Supabase `kortix.runtime_config`)**:
  - **Strict Free-Only Guard**: `assertFreeOpenRouterModelId` / `isAllowedFreeOpenRouterModelId` permits only `:free` models or `openrouter/free` ($0.00 cost) at both gateway resolution and wire dispatch.
  - **Cloud Hot-Swapping (Zero APK Rebuilds)**: Active ordered model list reads from Supabase `kortix.runtime_config` (`key = 'openrouter_free_models'`, 30s in-memory cache via `refreshOpenRouterFreeChainIfStale()`), falling back to Railway env var `OPENROUTER_FREE_MODELS`, then `DEFAULT_OPENROUTER_FREE_CHAIN` (`nvidia/nemotron-3.5-lightning:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3.5-super-vl:free`, `openrouter/free`).
  - **Fast Failover + Circuit Breaker**: `openRouterFreeBreakers` (`consecutiveFailures: 1`, `cooldownMs: 300_000`, `maxCooldownMs: 600_000`) + `tripsOpenRouterBreaker` (`404`/`408`/`409`/`425`/`429`/`5xx`/network timeout) + `OPENROUTER_FIRST_TOKEN_TIMEOUT_MS` (`15_000` ms) immediately trips unhealthy models for 5 minutes and fails over to the next healthy free model.
  - **Live Railway Proof (`kortix-api`, deploy `20b89a73`)**: `/health` & `/health/ready` `HTTP 200`, paid override rejected/forced onto `nvidia/nemotron-3.5-lightning:free`, live `web_search` tool call `HTTP 200`, and live Cloud Hot-Swap + automatic failover verified end-to-end.
- **Daytona Storage/Container Cleanup & Proactive LRU Slot Manager**:
  - Audited live Daytona `eu` Tier-1 limits (`10 vCPU`, `10 GiB` RAM, `30 GiB` disk). Safely archived 2 stopped Kortix sandboxes freeing `20 GiB` disk and removed duplicate snapshot `kortix-default-e9cc19c4f2bb` (`6.05 GB`). Left 3 unrelated `build-x` `error` sandboxes (`3 GiB` each) and `9` archived `build-x` boxes untouched.
  - Implemented `ensureDaytonaCapacitySlot`, `reclaimDaytonaDiskSlots`, and `runWithDaytonaQuotaRetry` (`KORTIX_DAYTONA_MAX_RUNNING_SANDBOXES=2`, `KORTIX_DAYTONA_MAX_NON_ARCHIVED_SANDBOXES=2`, `managed` Kortix filter only, auto-stop `5m`, auto-archive `5m`).
  - Verified 3-chat concurrent session start live (`S1`, `S2`, `S3` all READY with LRU disk reclaim) followed by clean test sandbox deletion.
- **Hardware-Safe Sequential Release Builds, Direct APK Hosting & Mobile-Only Web Download Overhaul**:
  - **Android Release APK (built first)**: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`, `89,572,194` bytes (`85.42 MB`), `arm64-v8a`, SHA-256 `E9CBBE0709BDB39F31481C2EBDAFF189A7B29C17D4A0B16AE7774135DCE6E620`, V2 signature verified; bundle scan confirmed `0` leaked secrets or upstream `kortix.com` links. Hosted directly at `https://github.com/MMUU6699/kortix-starter-workspace/releases/download/android-latest/kortix-latest.apk` (`HEAD` `HTTP 200`, `Content-Length: 89572194`).
  - **Mobile-Only Web Download Overhaul (`apps/web`, `@kortix/ui`)**: Removed all desktop installers/banners (`.dmg`, `.exe`, `.AppImage`, `Desktop` nav/promo items) and all App Store / Google Play / Microsoft Store links & badges across `/download`, `/mobile`, `/desktop` (redirects to `/download`), `/download/[platform]`, `MobileAppPromo`, `ComputerConnect`, `AppsModal`, and `ComputerTab`. Rendered centered Mobile-Only Download UI with direct **Download APK** button + non-clickable **iOS Coming Soon** (`قريباً` in Arabic) badge.
  - **Verification**: `@kortix/ui` & `apps/web` `tsgo --noEmit` exit `0`; `11/11` targeted download unit tests pass (`route.test.ts`, `pairing.test.tsx`, `platform-card.test.tsx`); split Next.js 16.4.2 build (`compile` + `generate`) exit `0` with `0` forbidden strings in `.next/static`; Netlify prod deploy (`6b01760fc9f8e2268759f8a7`) live-verified `HTTP 200` on `/`, `/auth`, `/download`, `/mobile`, `/api/health`, `HTTP 302` `/download/android` -> direct APK, and `/download/{ios,macos,windows,linux}` -> `/download`.

---

## Phase 8 — Cloud-Only Unified Free Multi-Model Vision + Tool-Calling Chain (NVIDIA NIM + OpenRouter `:free`) & Inline Execution Fix (Zero APK Rebuild)
- **Status**: `COMPLETED & VERIFIED LIVE`
- **Live NVIDIA NIM Discovery & Benchmark (`https://integrate.api.nvidia.com/v1`)**:
  - Queried `GET /v1/models` (`33` accessible models) and benchmarked streaming TTFT/total latency, OpenAI-compatible `tools` (`web_search`), and Vision (`image_url` PNG data URI) with `chat_template_kwargs: { enable_thinking: false }` and `max_tokens: 4096..8192`:
    1. `nvidia/nemotron-3.5-super-vl-120b-a12b` (`nvidia`): Vision **Yes (`1,129 ms`, `"Red"`)**, Tools **Yes (`724 ms`)**, Stream TTFT **`735 ms`** / Total **`740 ms`**
    2. `stepfun-ai/step-5-preview` (`nvidia`): Vision **Yes (`3,353 ms`, `"Red"`)**, Tools **Yes (`1,527 ms`)**, Stream TTFT **`581 ms`** / Total **`1,095 ms`**
    3. `minimaxai/minimax-m3.1-flash` (`nvidia`): Vision **Yes (`7,385 ms`, `"Red"`)**, Tools **Yes (`2,290 ms`)**, Stream TTFT **`808 ms`** / Total **`847 ms`**
    4. `nvidia/nemotron-3.5-lightning-30b-a3b` (`nvidia`): Vision **No**, Tools **Yes (`517 ms`)**, Stream TTFT **`446 ms`** / Total **`458 ms`**
    5. `nvidia/nemotron-3-ultra-550b-a55b` (`nvidia`): Vision **No**, Tools **Yes (`1,784 ms`)**, Stream TTFT **`987 ms`** / Total **`1,020 ms`**
- **9-Model 100% Free Multi-Provider Chain (`kortix.runtime_config` + `OPENROUTER_FREE_MODELS`)**:
  1. `nvidia/nemotron-3.5-super-vl-120b-a12b` (NVIDIA NIM — Vision + Tools)
  2. `stepfun-ai/step-5-preview` (NVIDIA NIM — Vision + Tools)
  3. `minimaxai/minimax-m3.1-flash` (NVIDIA NIM — Vision + Tools)
  4. `nvidia/nemotron-3.5-lightning-30b-a3b` (NVIDIA NIM — Text + Tools)
  5. `nvidia/nemotron-3-ultra-550b-a55b` (NVIDIA NIM — Text + Tools)
  6. `nvidia/nemotron-3.5-super-vl:free` (OpenRouter — Vision + Tools)
  7. `nvidia/nemotron-3.5-lightning:free` (OpenRouter — Text + Tools)
  8. `nvidia/nemotron-3-ultra-550b-a55b:free` (OpenRouter — Text + Tools)
  9. `openrouter/free` (OpenRouter — Free Models Router safety net)
- **3 Cloud-Only Fixes Applied (`packages/llm-gateway` + `apps/api`)**:
  1. **Fix 1 — Unified Free Multi-Provider Gateway + Vision Routing Guard**:
     - Added `ALLOWED_FREE_NVIDIA_MODELS`, `VISION_CAPABLE_FREE_MODELS`, `isAllowedFreeNvidiaModelId`, `isAllowedFreeModelId`, `isVisionCapableFreeModelId`, `assertFreeNvidiaModelId`, and `assertFreeModelId` (`$0.00` strict guard).
     - Configured `buildNvidiaNimPayload()` to default `chat_template_kwargs: { enable_thinking: false }`, `temperature: 0.2`, `max_tokens: 4096..8192`, and `15,000 ms` first-token timeout + 1-failure circuit breaker (`openRouterFreeBreakers`) across both `nvidia` and `openrouter`.
     - Updated `resolveGatewayRoute()` and `openRouterFreeChainForRequest({ requiresVision })` so multimodal requests (`input.requires.imageInput === true`) route strictly across Vision-capable free models.
  2. **Fix 2 — `Mykortix` Inline Execution (No Unnecessary Sub-Agent Multiplication)**:
     - Updated `WORK` in `apps/api/src/projects/lib/my-kortix-prompt.ts` (`MY_KORTIX_PROMPT`) so `Mykortix` executes single-session web searches, URL visits, file creation, and single-page or multi-file HTML/CSS/JS website builds directly inline in `/workspace` using its own tools (`web_search`, `scrape_webpage`, `write`, `edit`, `read`, `bash`, `show`) instead of spawning 2–3 `General` sub-agent sessions via `agent`.
  3. **Fix 3 — Cap `429 model_busy` Retry Loop & Clean Error Copy**:
     - Updated `publicUpstreamError()` (`packages/llm-gateway/src/pipeline/public-identity.ts`) so the final `429 model_busy` message after 9-tier failover includes `(usage limit reached)` (matching `kortixd`'s `PERMANENT = /usage limit/i` classifier to stop infinite `Attempt 8 · Retrying in 190s` loops) and removed `"or choose another model"` from suggestions.
- **Live Railway Deployment & Verification (`523bba8f-c67e-41e5-b16d-277d119834e3`, `SUCCESS`)**:
  - `/health` and `/health/ready` verified `HTTP 200`.
  - Live Streaming Chat via Railway gateway: `HTTP 200`, TTFT **`865 ms`**, Total **`1,034 ms`** (`nvidia/nemotron-3.5-super-vl-120b-a12b`, `$0.00000`).
  - Live Tool Calling (`web_search`) via Railway gateway: `HTTP 200`, Total **`875 ms`** (`nvidia/nemotron-3.5-super-vl-120b-a12b`, valid JSON `tool_calls`, `$0.00000`).
  - Live Vision (`image_url` 32x32 solid red PNG) via Railway gateway: `HTTP 200`, Total **`1,769 ms`** (`nvidia/nemotron-3.5-super-vl-120b-a12b`, reply `"Red"`, `$0.00000`).

---

## Phase 9 — Image Upload RLS Fix (`prompt-attachments`), Duplicate User Message & False `Live updates paused` Fix, and Code-Grounded `Mykortix` Tool & Browser Audit
- **Status**: `COMPLETED & VERIFIED`
- **1. `prompt-attachments` Image Upload RLS Fix & Live Re-Test D Verification**:
  - **Root Cause**: `apps/api/src/projects/prompt-attachment-storage.ts` writes attachments to the `staged-files` Supabase Storage bucket using `config.SUPABASE_SERVICE_ROLE_KEY`. On Railway, `SUPABASE_SERVICE_ROLE_KEY` had been configured with the `anon` JWT (`role: "anon"`), causing Supabase Storage RLS to reject writes with `403 new row violates row-level security policy` (`503 Attachment storage is unavailable`).
  - **Fix**: Updated `SUPABASE_SERVICE_ROLE_KEY` on Railway (`kortix-api`) with the project's `service_role` JWT (deploy `2219bcf9-1e74-4733-9911-dc83924611e0`, `SUCCESS`).
  - **Live Re-Test D Proof on USB Phone (`SM_A515F`)**:
    - `POST /v1/workspaces/:id/attachments` -> `201` (`535 ms`)
    - `POST /v1/workspaces/:id/attachments/:id/complete` -> `200` (`334 ms`)
    - `GET /v1/workspaces/:id/runtime/prompt-attachments/:id` -> `200` (`149 ms`)
    - `POST /v1/llm/chat/completions` (`nvidia/nemotron-3.5-super-vl-120b-a12b`, `$0.00000`) -> `200` (`2,585 ms`), rendering `"The image is solid red."` on the phone screen (`E:\luna\tmp_qa\retest_d2_poll_3.png`).
- **2. Duplicate User Message / Optimistic Queue Bug & False `Live updates paused · Reconnect` Fix (`packages/sdk` + `apps/mobile`)**:
  - **Root Cause #1 (v2 Session Log never retired v1 Optimistic User Messages)**:
    - All `pi` sessions negotiate `schema=v2` (`kortix.session/2`). On Project Home first-prompt sends, `apps/mobile/lib/session/project-connect.ts` (`seedFirstPrompt`) inserts a client-minted optimistic message (`time.created = Date.now()`) into `useSyncStore.messages[rootId]` via `addOptimisticMessage` + `markSeededPrompt` (`markOptimisticDispatched`) after `/start` returns.
    - Because v2 messages arrive only via `applySessionLogPage()` and `applySessionLogFrame()` (`packages/sdk/src/browser/stores/sync-store.ts`), which previously never retired v1 optimistic rows in `state.messages[threadId]`, `sessionLogThreadWithV1Rows()` (`packages/sdk/src/core/session-log/v1-view.ts`) merged the unretired client seed into `thread.messages` by `created_at` — placing a duplicate user bubble **below** the assistant reply until a manual pull-to-refresh triggered v1 `hydrate()`.
  - **Root Cause #2 (Re-minted follow-up echo pairing & unfiltered `QueuePanel` on Mobile)**:
    - `packages/sdk/src/browser/stores/sync-store.ts` (`registerOptimisticEcho`) only checked `state.messages[sessionID]` (v1) before retiring a re-minted optimistic bubble, ignoring v2 `state.sessionLogs`.
    - `apps/mobile/components/session/SessionPage.tsx` never registered `wire_message_id -> message_id` echo aliases from `sdkQueue.prompts` / `sdkQueue.sent` and passed unfiltered `sdkQueue.prompts` directly to `QueuePanel` (`Up next · 1`), flashing first prompts and already-rendered transcript messages in the queue header.
  - **Root Cause #3 (False `Live updates paused · Reconnect` banner on idle / fast-completing sessions)**:
    - In `packages/sdk/src/react/use-runtime-events/connect-stream.ts`, when using the shared R5.3 session stream (`sessionStreamEventClient`), `openEventStream` only transitioned from `'connecting'` to `'open'` upon receiving a yielded runtime event. On an idle session or when a fast turn completed before SSE attached, only control frames and heartbeats arrived, leaving `useStreamHealthStore` stuck in `'connecting'` until `STREAM_STALLED_MS` (`120 s`) triggered a false `Live updates paused · Reconnect` banner.
  - **Fixes Applied**:
    - Added `retireOptimisticUsersForSessionLog()` and `sessionLogHoldsMessage()` in `packages/sdk/src/browser/stores/sync-store.ts`, retiring confirmed/aliased/dispatched-seed optimistic user messages atomically in `applySessionLogPage()`, `applySessionLogFrame()`, and `registerOptimisticEcho()`.
    - Wired `openSessionStream.onConnectionChange` and `onEnded` in `packages/sdk/src/react/use-runtime-events/connect-stream.ts` to emit `connecting` / `open` / `lost` / `parked` signals on `subscribeRuntimeStream`.
    - Added `registerOptimisticEcho`, `optimisticEchoOf`, `optimisticOriginOf`, and `sessionLogHasUserMessage` in `apps/mobile/lib/session/session-store.ts`, `filterVisibleQueuePrompts` in `apps/mobile/lib/session/queue-undo.ts`, guard in `apps/mobile/lib/session/project-connect.ts`, and echo registration + queue filtering in `apps/mobile/components/session/SessionPage.tsx`.
  - **Updated Android Release APK**:
    - Path: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
    - Size: `89,575,626` bytes (`85.43 MB`), `arm64-v8a`
    - SHA-256: `8DAE8C346C0F7B8C3FA5E4CD517A471C4F56DBADD213140250879351E439B2A8`
    - Direct Download URL: `https://github.com/MMUU6699/kortix-starter-workspace/releases/download/android-latest/kortix-latest.apk` (`HTTP 200`, `Content-Length: 89575626`).
- **3. Code-Grounded Audit of `Mykortix` Real Tools & Interactive Browser**:
  - Audited all 27 registered tools across `apps/kortix-sandbox-agent-server/src/harness/pi/tools.ts`, `runtime.ts`, `codemode.ts`, `extensions/*.ts`, and `services/tools/{host,kortix,platform}` plus Daytona image layers (`packages/shared/src/sandbox/dockerfile-layer.ts`, `desktop.ts`, `my-kortix-dockerfile.ts`, `apps/sandbox/entrypoint.sh`) and Web/Mobile UI (`packages/ui/src/session/panel/session-desktop.tsx`, `apps/mobile/components/pages/BrowserPage.tsx`, `apps/mobile/components/session/SandboxPreviewSheet.tsx`).
