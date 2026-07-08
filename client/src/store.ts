import { create } from 'zustand';
import type { ReviewReport, Regulation, StepResult, AuthUser } from './types';

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
  
  // 认证
  token: string | null;
  user: AuthUser | null;
  
  // 方法
  setCurrentPage: (page: 'review' | 'regulations' | 'reports') => void;
  setViewingReportId: (id: string | null) => void;
  setCurrentReport: (report: ReviewReport | null) => void;
  updateReviewingSteps: (steps: StepResult[] | ((prev: StepResult[]) => StepResult[])) => void;
  setIsReviewing: (isReviewing: boolean) => void;
  setRegulations: (regulations: Regulation[]) => void;
  resetReview: () => void;
  setAuth: (token: string, user: AuthUser) => void;
  logout: () => void;
}

// 从 localStorage 恢复登录状态
const persistedToken = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
const persistedUser = typeof localStorage !== 'undefined'
  ? (() => { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; } })()
  : null;

export const useAppStore = create<AppState>((set) => ({
  currentPage: 'review',
  viewingReportId: null,
  currentReport: null,
  reviewingSteps: [],
  isReviewing: false,
  regulations: [],
  token: persistedToken,
  user: persistedUser,
  
  setCurrentPage: (page) => set({ currentPage: page }),
  setViewingReportId: (id) => set({ viewingReportId: id }),
  setCurrentReport: (report) => set({ currentReport: report }),
  updateReviewingSteps: (steps) => set((state) => ({ 
    reviewingSteps: typeof steps === 'function' ? steps(state.reviewingSteps) : steps 
  })),
  setIsReviewing: (isReviewing) => set({ isReviewing }),
  setRegulations: (regulations) => set({ regulations }),
  resetReview: () => set({ reviewingSteps: [], isReviewing: false }),
  setAuth: (token, user) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ token, user });
  },
  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    set({ token: null, user: null, currentPage: 'review' });
  },
}));
