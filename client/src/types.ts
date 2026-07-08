// 从 shared/types 重新导出，避免类型定义重复维护
export * from '../../shared/types';

// 客户端专用类型
export interface ReportSummary {
  id: string;
  fileName: string;
  projectName: string;
  overallScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
}
