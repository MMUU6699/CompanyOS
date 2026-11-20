'use client';

/**
 * `ProjectProviderModal` — the QUICK version of the Models page, and nothing
 * else.
 *
 * ## It is the same screen, or it is wrong
 *
 * This dialog used to be a second implementation of model management: its own
 * `Tabs` root, its own underline tab row at `text-xs`, its own labels ("API
 * keys" where the page says "Providers"), no project-default control, and — the
 * visible bug — a scroll body with NO horizontal padding, so the search field
 * and every model row ran edge to edge under a heading indented 20px, and the
 * row card's rounded border was clipped away by the modal's `overflow-hidden`.
 * Beside the page it read as a different, older product.
 *
 * There is one implementation now. Every part below is imported from
 * `gateway-view.tsx`, the Customize page's own module:
 *
 *   - `MODELS_PAGE_TITLE` / `MODELS_PAGE_DESCRIPTION` — the same two lines.
 *   - `ProjectDefaultPicker` — the same one page-level control, in the same
 *     place relative to the heading.
 *   - `QUICK_LLM_TABS` + `LlmTabStrip` — the same pill strip, the same labels,
 *     the same order. A slice of `LLM_TABS`, never a second list.
 *   - `LlmSections` — the same section bodies, chosen the same way.
 *
 * This file contributes the dialog chrome and the padded column, full stop. It
 * declares no `TabsTrigger`, no section, and no label of its own; a change to
 * any of those has exactly one place to be made.
 *
 * ## Why three tabs and not seven
 *
 * The page carries Providers / Models / Custom / Gateway / Routing / Costs /
 * Logs. This dialog opens from the session model picker's connect gate
 * (`use-model-connection-gate.tsx`) and the Secrets tab's "Manage providers"
 * (`secrets-view.tsx`) — both are "let me use a model right now" moments. It
 * carries the three tabs that answer that and drops the four that are project
 * administration; a log table wants the page's width and height, not 680px of
 * dialog. `QUICK_LLM_TABS` is that decision, expressed once.
 *
 * The Models settings tab mounts `LlmManagementView` DIRECTLY — connecting a
 * provider there opens no dialog at all, which is JAY-510's first acceptance
 * criterion.
 */

import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '../../../primitives/modal';
import {
  isQuickLlmTab,
  LlmSections,
  LlmTabStrip,
  MODELS_PAGE_DESCRIPTION,
  MODELS_PAGE_TITLE,
  ProjectDefaultPicker,
  ProviderSheetSplit,
  QUICK_LLM_TABS,
} from '../gateway-view';
import { useState } from 'react';
import type { ActiveTab, ProjectProviderModalProps } from './types';
import { pickInitialTab } from './utils';

export type { ProjectProviderModalProps } from './types';

export function ProjectProviderModal(_props: ProjectProviderModalProps) {
  // LLM provider & BYOK configuration is disabled; model is locked in backend.
  return null;
}

/**
 * The body, below the `key` boundary the shell owns.
 *
 * CONTROLLED, but with no effect and no re-seeding: `useState`'s initializer
 * runs once per mount, and the parent's `key={`${open}-${defaultTab}`}`
 * remounts this on every open — so reopening still lands on the requested tab,
 * exactly as the uncontrolled version did, with no `setState` in an effect
 * body (`react-hooks/set-state-in-effect`).
 *
 * Controlled at all because `LlmSections` hands the reader on: saving a custom
 * provider gives it a key like any other and a row on the provider list, so a
 * "Done" that leaves you on the form you just submitted is not done.
 */
function ProviderModalBody({
  projectId,
  open,
  canWrite,
  defaultTab,
  defaultProviderId,
}: {
  projectId: string;
  open: boolean;
  canWrite: boolean;
  defaultTab?: ActiveTab;
  defaultProviderId?: string;
}) {
  const [tab, setTab] = useState<ActiveTab>(() => pickInitialTab(defaultTab));

  return (
    <>
      {/* The page's header, in a dialog: heading and description on the left,
          the one page-level control on the right. `pr-11` is the modal's close
          button — `absolute top-3 right-3` at `size-8`, so 44px of the right
          edge is spoken for and the picker has to stop short of it. */}
      <ModalHeader className="shrink-0 gap-0 px-5 pt-4 pr-64">
        <ModalTitle className="text-base leading-8 font-medium">{MODELS_PAGE_TITLE}</ModalTitle>
        <ModalDescription>{MODELS_PAGE_DESCRIPTION}</ModalDescription>
      </ModalHeader>

      <div className="shrink-0 px-5">
        <LlmTabStrip
          value={tab}
          tabs={QUICK_LLM_TABS}
          onValueChange={(next) => {
            if (isQuickLlmTab(next)) setTab(next);
          }}
        />
      </div>

      {/* The column. `px-5` is the whole reason the model rows now line up
          under the heading instead of running into the modal's clipped edge —
          `LlmSections` carries no horizontal padding of its own, because on
          the page `CapabilityPageShell` supplies it. */}
      <ProviderSheetSplit
        projectId={projectId}
        providerId={null}
        onProviderChange={() => undefined}
        canWrite={canWrite}
        className="min-h-0 border-t"
        contentClassName="bg-background"
      >
        <div className="h-full min-h-0 overflow-y-auto px-5 pt-4 pb-5">
          <LlmSections
            projectId={projectId}
            tab={tab}
            onTabChange={(next) => {
              if (isQuickLlmTab(next)) setTab(next);
            }}
            canWrite={canWrite}
            enabled={open}
            selectedProviderId={defaultProviderId}
            onSelectProvider={() => undefined}
            providersVariant="accordion"
          />
        </div>
      </ProviderSheetSplit>
    </>
  );
}
