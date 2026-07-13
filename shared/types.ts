// 共享类型定义

export interface ProjectInfo {
  projectName: string;
  province: string;
  city: string;
  supportType: string; // 支护形式
  excavationDepth: number; // 开挖深度（米）
  geologicalConditions: string;
  groundwater: string;
  surroundingEnvironment: string;
}

export interface Finding {
  id: string;
  stepName: string;
  severity: 'critical' | 'major' | 'minor' | 'info';
  category: string;
  title: string;
  description: string;
  location?: string;
  recommendation?: string;
}

export interface StepResult {
  stepNumber: number;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'skipped';
  findings: Finding[];
  summary?: string;
  error?: string;
}

/** 扣分明细 —— 单一严重度的扣分汇总 */
export interface DeductionGroup {
  severity: 'critical' | 'major' | 'minor' | 'info';
  count: number;
  weightPerItem: number; // 每条扣分权重
  totalDeduction: number; // 该组总扣分 = count * weightPerItem
}

/** 评分结果 —— 确定性引擎输出 */
export interface ScoreBreakdown {
  baseScore: number; // 基础分（100）
  deductions: DeductionGroup[]; // 按严重度分组的扣分明细
  totalDeduction: number; // 总扣分
  finalScore: number; // 最终得分 = max(0, baseScore - totalDeduction)
  aiSuggestedScore?: number; // AI 建议分（仅参考，不参与计算）
  aiScoreReason?: string; // AI 建议分的理由
}

export interface ReviewReport {
  id: string;
  fileName: string;
  projectInfo: ProjectInfo;
  overallScore: number; // 0-100（确定性引擎计算）
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  steps: StepResult[];
  comprehensiveAssessment: string;
  scoreBreakdown?: ScoreBreakdown; // 扣分明细
  createdAt: string;
}

export interface Regulation {
  id: string;
  name: string;
  code: string; // 如 JGJ 120-2012
  category: 'national' | 'industry' | 'local';
  province?: string;
  clauses: RegulationClause[];
  uploadedAt: string;
  chunkCount?: number; // 向量库中的分块数量
}

export interface RegulationClause {
  id: string;
  section: string;
  content: string;
  isMandatory: boolean; // 是否强条
}

export interface VectorSearchResult {
  id: string;
  regulation: string;
  section: string;
  content: string;
  isMandatory: boolean;
  category: string;
  province: string;
  score: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatRequest {
  reportId: string;
  message: string;
  history?: ChatMessage[];
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface AuthUser {
  username: string;
  name: string;
}
