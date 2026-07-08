import { create } from 'zustand';
import type { ReviewReport, Regulation, StepResult } from './types';

interface AppState {
  // 页面导航
  currentPage: 'review' | 'regulations' | 'reports';
  viewingReportId: string | null;
  
  // 审核相关
  currentReport: ReviewReport | null;
  reviewingSteps: StepResult[];
  isReviewing: boolean;
  
  // 法规库
  regulations: Regulation[];
  
  // 方法
  setCurrentPage: (page: 'review' | 'regulations' | 'reports') => void;
  setViewingReportId: (id: string | null) => void;
  setCurrentReport: (report: ReviewReport | null) => void;
  updateReviewingSteps: (steps: StepResult[] | ((prev: StepResult[]) => StepResult[])) => void;
  setIsReviewing: (isReviewing: boolean) => void;
  setRegulations: (regulations: Regulation[]) => void;
  resetReview: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentPage: 'review',
  viewingReportId: null,
  currentReport: null,
  reviewingSteps: [],
  isReviewing: false,
  regulations: [],
  
  setCurrentPage: (page) => set({ currentPage: page }),
  setViewingReportId: (id) => set({ viewingReportId: id }),
  setCurrentReport: (report) => set({ currentReport: report }),
  updateReviewingSteps: (steps) => set((state) => ({ 
    reviewingSteps: typeof steps === 'function' ? steps(state.reviewingSteps) : steps 
  })),
  setIsReviewing: (isReviewing) => set({ isReviewing }),
  setRegulations: (regulations) => set({ regulations }),
  resetReview: () => set({ reviewingSteps: [], isReviewing: false }),
}));
