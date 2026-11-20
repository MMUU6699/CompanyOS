'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { getWorkspaceModelPicker } from '@kortix/sdk';
import {
  contract,
  flattenModels,
  projectLlmCatalogToProviderList,
  qk,
  useFeatureFlag,
} from '@kortix/sdk/react';

import { useUiViewerId } from '../../providers/ui-provider';
import { isRunnableModel } from './model-availability';
import {
  readModelReady,
  resolveWorkspaceModelGate,
  writeModelReady,
  type WorkspaceModelGateView,
} from './workspace-model-gate';

/**
 * While the workspace is blocked, re-read the model list on this cadence, so a
 * connection made elsewhere (another tab, another device, a person who manages
 * the workspace) opens it without a reload. The same cadence as the access
 * gate's approval poll. A connection made on this screen does not wait for
 * it: the provider dialog's save invalidates the same query at once
 * (`refreshWorkspaceProviderState`).
 */
const BLOCKED_RECHECK_MS = 15_000;

/**
 * Whether `projectId` may open for the signed-in viewer: `'open'`,
 * `'pending'` (no answer yet, and this browser never saw it ready) or
 * `'blocked'` (no model can run). See `workspace-model-gate.ts` for the rules.
 *
 * Reads `/model-picker` through its shared cache entry
 * (`qk.project.modelPicker`), the one the composer, the model picker and the
 * shell prefetch read, so it adds no request to a workspace load.
 */
export function useWorkspaceModelGate(_projectId: string): WorkspaceModelGateView {
  // Backend locks a single always-available model (NVIDIA Gemma 4 31B); never block workspace access.
  return 'open';
}

function flattenCatalog(catalog: Parameters<typeof projectLlmCatalogToProviderList>[0]) {
  return flattenModels(projectLlmCatalogToProviderList(catalog));
}
