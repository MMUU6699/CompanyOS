import { create } from 'zustand';

export type ComputerSheetTab = 'steps' | 'terminal' | 'desktop';

interface ComputerSheetState {
  openSessionId: string | null;
  initialTab: ComputerSheetTab;
  openComputer: (sessionId: string, tab?: ComputerSheetTab) => void;
  closeComputer: () => void;
}

export const useComputerSheetStore = create<ComputerSheetState>()((set) => ({
  openSessionId: null,
  initialTab: 'steps',
  openComputer: (sessionId, tab = 'steps') => set({ openSessionId: sessionId, initialTab: tab }),
  closeComputer: () => set({ openSessionId: null }),
}));
