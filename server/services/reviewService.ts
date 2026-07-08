import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { AIService } from './aiService.js';
import { RegulationService } from './regulationService.js';
import { FileParser } from '../utils/fileParser.js';
import { vectorStore } from './vectorStore.js';
import type { ReviewReport, StepResult, Finding } from '../../shared/types.js';

export class ReviewService {
  private aiService: AIService;
  private regulationService: RegulationService;

  constructor() {
    this.aiService = new AIService();
    this.regulationService = new RegulationService();
  }

  /**
   * 执行完整的 6 步审核流水线
   */
  async runReview(
    filePath: string,
    mimeType: string,
    fileName: string,
    onProgress?: (step: StepResult) => void
  ): Promise<ReviewReport> {
    // 解析文件文本
    const rawText = await FileParser.parseFile(filePath, mimeType);
    const documentText = FileParser.cleanText(rawText);

    // 报告 ID 前置生成，用于关联向量库中的方案原文
    const reportId = `report-${Date.now()}`;

    // 向量化方案原文，供专家对话 RAG 检索（失败不影响审核主流程）
    try {
      const schemeChunks = vectorStore.chunkSchemeText(documentText, reportId);
      await vectorStore.insertSchemeChunks(schemeChunks);
      console.log(`[Review] 方案原文已向量化，分块数：${schemeChunks.length}`);
    } catch (err: any) {
      console.error('[Review] 方案原文向量化失败（不影响审核）：', err.message);
    }

    const steps: StepResult[] = [];
    const allFindings: Finding[] = [];

    // Step 0: 提取基本信息
    const step0: StepResult = { stepNumber: 0, stepName: '提取基本信息', status: 'running', findings: [] };
    onProgress?.(step0);

    const projectInfo = await this.aiService.extractProjectInfo(documentText);
    step0.status = 'completed';
    step0.summary = `已提取项目信息：${projectInfo.projectName}，${projectInfo.supportType}，开挖深度 ${projectInfo.excavationDepth}m`;
    steps.push({ ...step0 });
    onProgress?.(step0);

    // Step 1: 完整性检查
    const step1: StepResult = { stepNumber: 1, stepName: '完整性检查', status: 'running', findings: [] };
    onProgress?.(step1);

    const findings1 = await this.aiService.checkCompleteness(documentText, projectInfo);
    step1.findings = findings1;
    step1.status = 'completed';
    step1.summary = `发现 ${findings1.length} 项完整性问题`;
    allFindings.push(...findings1);
    steps.push({ ...step1 });
    onProgress?.(step1);

    // Step 2: 合规性检查
    const step2: StepResult = { stepNumber: 2, stepName: '合规性检查', status: 'running', findings: [] };
    onProgress?.(step2);

    const mandatoryClauses = await this.regulationService.getMandatoryClauses();
    const findings2 = await this.aiService.checkCompliance(documentText, mandatoryClauses);
    step2.findings = findings2;
    step2.status = 'completed';
    step2.summary = `核对强条，发现 ${findings2.length} 项合规问题`;
    allFindings.push(...findings2);
    steps.push({ ...step2 });
    onProgress?.(step2);

    // Step 3: 支护专项检查
    const step3: StepResult = { stepNumber: 3, stepName: '支护专项检查', status: 'running', findings: [] };
    onProgress?.(step3);

    const findings3 = await this.aiService.checkSupportSpecific(documentText, projectInfo);
    step3.findings = findings3;
    step3.status = 'completed';
    step3.summary = `发现 ${findings3.length} 项支护专项问题`;
    allFindings.push(...findings3);
    steps.push({ ...step3 });
    onProgress?.(step3);

    // Step 4: 地方法规审查
    const step4: StepResult = { stepNumber: 4, stepName: '地方法规审查', status: 'running', findings: [] };
    onProgress?.(step4);

    const localClauses = await this.regulationService.getLocalClausesByProvince(projectInfo.province);
    const findings4 = await this.aiService.checkLocalRegulations(documentText, projectInfo, localClauses);
    step4.findings = findings4;
    step4.status = 'completed';
    step4.summary = `地方法规审查完成，发现 ${findings4.length} 项问题`;
    allFindings.push(...findings4);
    steps.push({ ...step4 });
    onProgress?.(step4);

    // Step 5: 汇总报告
    const step5: StepResult = { stepNumber: 5, stepName: '汇总报告', status: 'running', findings: [] };
    onProgress?.(step5);

    const { score, assessment } = await this.aiService.generateSummaryReport(projectInfo, allFindings);
    step5.status = 'completed';
    step5.summary = `审核完成，综合评分：${score}`;
    steps.push({ ...step5 });
    onProgress?.(step5);

    // 计算风险等级
    const riskLevel = this.calculateRiskLevel(score, allFindings);

    const report: ReviewReport = {
      id: reportId,
      fileName,
      projectInfo,
      overallScore: score,
      riskLevel,
      steps,
      comprehensiveAssessment: assessment,
      createdAt: new Date().toISOString(),
    };

    // 保存报告
    await this.saveReport(report);
    return report;
  }

  /**
   * 获取所有报告列表
   */
  async getAllReports(): Promise<ReviewReport[]> {
    try {
      await fs.mkdir(config.paths.reports, { recursive: true });
      const files = await fs.readdir(config.paths.reports);
      const reports: ReviewReport[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = await fs.readFile(path.join(config.paths.reports, file), 'utf-8');
          reports.push(JSON.parse(content));
        }
      }

      return reports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch {
      return [];
    }
  }

  /**
   * 获取单个报告
   */
  async getReport(id: string): Promise<ReviewReport | null> {
    try {
      const filePath = path.join(config.paths.reports, `${id}.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * 删除报告
   */
  async deleteReport(id: string): Promise<void> {
    const filePath = path.join(config.paths.reports, `${id}.json`);
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      // 文件不存在，忽略
    }
    // 同步删除该报告关联的方案原文向量
    try {
      await vectorStore.deleteSchemeByReportId(id);
    } catch (err: any) {
      console.error('[Review] 删除方案原文向量失败：', err.message);
    }
  }

  /**
   * 删除报告中的单条问题并重算分数
   */
  async deleteFinding(reportId: string, findingId: string): Promise<ReviewReport | null> {
    const report = await this.getReport(reportId);
    if (!report) return null;

    // 从对应步骤中移除该 finding
    let removed: Finding | null = null;
    for (const step of report.steps) {
      const idx = step.findings.findIndex(f => f.id === findingId);
      if (idx >= 0) {
        removed = step.findings.splice(idx, 1)[0];
        // 更新步骤摘要
        step.summary = `${step.stepName}完成，发现 ${step.findings.length} 项问题`;
        break;
      }
    }

    if (!removed) return null;

    // 收集剩余全部 findings
    const allFindings = report.steps.flatMap(s => s.findings);

    // 重新计算分数（使用兜底公式）
    const criticalCount = allFindings.filter(f => f.severity === 'critical').length;
    const majorCount = allFindings.filter(f => f.severity === 'major').length;
    const minorCount = allFindings.filter(f => f.severity === 'minor').length;
    const newScore = Math.max(0, 100 - criticalCount * 10 - majorCount * 5 - minorCount * 2);

    // 重新计算风险等级
    const newRiskLevel = this.calculateRiskLevel(newScore, allFindings);

    report.overallScore = newScore;
    report.riskLevel = newRiskLevel;
    report.comprehensiveAssessment = `方案共发现 ${allFindings.length} 项问题，其中严重 ${criticalCount} 项，重要 ${majorCount} 项，一般 ${minorCount} 项。请按严重程度优先整改。`;

    // 保存更新后的报告
    await this.saveReport(report);
    return report;
  }

  calculateRiskLevel(score: number, findings: Finding[]): ReviewReport['riskLevel'] {
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    if (criticalCount > 0 || score < 40) return 'critical';
    if (score < 60) return 'high';
    if (score < 75) return 'medium';
    return 'low';
  }

  private async saveReport(report: ReviewReport): Promise<void> {
    await fs.mkdir(config.paths.reports, { recursive: true });
    const filePath = path.join(config.paths.reports, `${report.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
  }
}
