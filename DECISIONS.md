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
