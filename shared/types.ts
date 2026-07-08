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
  status: 'pending' | 'running' | 'completed' | 'error';
  findings: Finding[];
  summary?: string;
  error?: string;
}

export interface ReviewReport {
  id: string;
  fileName: string;
  projectInfo: ProjectInfo;
  overallScore: number; // 0-100
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  steps: StepResult[];
  comprehensiveAssessment: string;
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
  history: ChatMessage[];
}
