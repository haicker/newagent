// 共享类型定义（与后端同步）

export interface ProjectInfo {
  projectName: string;
  province: string;
  city: string;
  supportType: string;
  excavationDepth: number;
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
  overallScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  steps: StepResult[];
  comprehensiveAssessment: string;
  createdAt: string;
}

export interface Regulation {
  id: string;
  name: string;
  code: string;
  category: 'national' | 'industry' | 'local';
  province?: string;
  clauses: RegulationClause[];
  uploadedAt: string;
  chunkCount?: number;
}

export interface RegulationClause {
  id: string;
  section: string;
  content: string;
  isMandatory: boolean;
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

export interface ReportSummary {
  id: string;
  fileName: string;
  projectName: string;
  overallScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
}
