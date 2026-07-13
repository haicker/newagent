import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { AIService } from './aiService.js';
import { RegulationService } from './regulationService.js';
import { ScoringEngine } from './scoringEngine.js';
import { FileParser } from '../utils/fileParser.js';
import { vectorStore } from './vectorStore.js';
import type { ReviewReport, StepResult, Finding, ChatMessage, ProjectInfo } from '../../shared/types.js';

/**
 * 审核控制器接口 —— 由路由层实现，服务层通过它检查暂停/跳过/重试等控制信号
 */
export interface ReviewController {
  aborted: boolean;
  pause(): void;
  resume(): void;
  requestSkip(): void;
  requestRetry(): void;
  abort(): void;
  waitIfPaused(): Promise<void>;
  consumeSkip(): boolean;
  consumeRetry(): boolean;
}

export class ReviewService {
  private aiService: AIService;
  private regulationService: RegulationService;

  /** 需要排除的 finding 关键字（标题/描述/分类中含任一即排除） */
  private static EXCLUDE_KEYWORDS = [
    '专家论证',
    '嵌固深度',
    '锚固长度',
    '抗突涌验算',
    '边坡稳定性验算',
  ];

  /** 图类问题识别关键字（标题中含任一即判定为图类问题） */
  private static DIAGRAM_KEYWORDS = [
    '图纸',
    '平面图',
    '剖面图',
    '示意图',
    '布置图',
    '详图',
  ];

  constructor() {
    this.aiService = new AIService();
    this.regulationService = new RegulationService();
  }

  /**
   * 执行完整的 6 步审核流水线（支持暂停/跳过/重试）
   */
  async runReview(
    filePath: string,
    mimeType: string,
    fileName: string,
    onProgress?: (step: StepResult) => void,
    onStatusChange?: (status: 'running' | 'paused') => void,
    controller?: ReviewController,
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

    // ── 通用步骤执行器：封装暂停/跳过/错误重试控制流 ──
    const runStep = async <T>(
      stepNumber: number,
      stepName: string,
      aiCall: () => Promise<T>,
    ): Promise<{ result: T | null; skipped: boolean }> => {
      const step: StepResult = { stepNumber, stepName, status: 'pending', findings: [] };
      steps.push(step);

      // 步骤前检查：取消 / 暂停等待 / 跳过
      if (controller?.aborted) throw new Error('审核已取消');
      if (controller) await controller.waitIfPaused();
      if (controller?.aborted) throw new Error('审核已取消');
      if (controller?.consumeSkip()) {
        step.status = 'skipped';
        step.summary = '已跳过此步骤';
        onProgress?.(step);
        return { result: null, skipped: true };
      }

      step.status = 'running';
      onProgress?.(step);

      // 步骤执行 + 错误重试循环
      while (true) {
        try {
          const result = await aiCall();

          // 执行期间用户点了"跳过"：丢弃结果
          if (controller?.consumeSkip()) {
            step.status = 'skipped';
            step.summary = '已跳过此步骤';
            onProgress?.(step);
            return { result: null, skipped: true };
          }

          step.status = 'completed';
          // 不在此调用 onProgress —— 调用者需要先设置 findings/summary
          return { result, skipped: false };
        } catch (err: any) {
          step.status = 'error';
          step.error = err.message;
          onProgress?.(step);

          if (!controller) throw err;

          // 暂停等待用户决策（重试 / 跳过）
          controller.pause();
          onStatusChange?.('paused');
          await controller.waitIfPaused();
          onStatusChange?.('running');

          if (controller.aborted) throw new Error('审核已取消');

          if (controller.consumeSkip()) {
            step.status = 'skipped';
            step.summary = '已跳过失败步骤';
            onProgress?.(step);
            return { result: null, skipped: true };
          }

          if (controller.consumeRetry()) {
            step.status = 'running';
            step.error = undefined;
            onProgress?.(step);
            continue; // 重试本步骤
          }

          // 默认跳过
          step.status = 'skipped';
          step.summary = '已跳过失败步骤';
          onProgress?.(step);
          return { result: null, skipped: true };
        }
      }
    };

    // ── Step 0: 提取基本信息 ──
    const defaultProjectInfo: ProjectInfo = {
      projectName: '未知工程',
      province: '未知',
      city: '未知',
      supportType: '未知',
      excavationDepth: 0,
      geologicalConditions: '未知',
      groundwater: '未知',
      surroundingEnvironment: '未知',
    };

    const step0Result = await runStep(0, '提取基本信息',
      () => this.aiService.extractProjectInfo(documentText));
    const projectInfo = step0Result.result || defaultProjectInfo;
    if (!step0Result.skipped) {
      steps[0].summary = `已提取项目信息：${projectInfo.projectName}，${projectInfo.supportType}，开挖深度 ${projectInfo.excavationDepth}m`;
      onProgress?.(steps[0]);
    }

    // ── Step 1: 完整性检查 ──
    const step1Result = await runStep(1, '完整性检查',
      () => this.aiService.checkCompleteness(documentText, projectInfo));
    if (!step1Result.skipped && step1Result.result) {
      const findings = step1Result.result;
      steps[1].findings = findings;
      steps[1].summary = `发现 ${findings.length} 项完整性问题`;
      allFindings.push(...findings);
      onProgress?.(steps[1]);
    }

    // ── Step 2: 合规性检查 ──
    const mandatoryClauses = await this.regulationService.getMandatoryClauses();
    const step2Result = await runStep(2, '合规性检查',
      () => this.aiService.checkCompliance(documentText, mandatoryClauses));
    if (!step2Result.skipped && step2Result.result) {
      const findings = step2Result.result;
      steps[2].findings = findings;
      steps[2].summary = `核对强条，发现 ${findings.length} 项合规问题`;
      allFindings.push(...findings);
      onProgress?.(steps[2]);
    }

    // ── Step 3: 支护专项检查 ──
    const step3Result = await runStep(3, '支护专项检查',
      () => this.aiService.checkSupportSpecific(documentText, projectInfo));
    if (!step3Result.skipped && step3Result.result) {
      const findings = step3Result.result;
      steps[3].findings = findings;
      steps[3].summary = `发现 ${findings.length} 项支护专项问题`;
      allFindings.push(...findings);
      onProgress?.(steps[3]);
    }

    // ── Step 4: 地方法规审查 ──
    const localClauses = await this.regulationService.getLocalClausesByProvince(projectInfo.province);
    const step4Result = await runStep(4, '地方法规审查',
      () => this.aiService.checkLocalRegulations(documentText, projectInfo, localClauses));
    if (!step4Result.skipped && step4Result.result) {
      const findings = step4Result.result;
      steps[4].findings = findings;
      steps[4].summary = `地方法规审查完成，发现 ${findings.length} 项问题`;
      allFindings.push(...findings);
      onProgress?.(steps[4]);
    }

    // ── Finding 后处理：排除特定关键字问题 + 合并图类问题 ──
    const beforeFilterCount = allFindings.length;
    allFindings.length = 0;
    allFindings.push(...this.filterAndMergeFindings(steps));
    const filteredCount = beforeFilterCount - allFindings.length;
    if (filteredCount > 0 || allFindings.length !== beforeFilterCount) {
      console.log(`[Review] Finding 过滤完成：原始 ${beforeFilterCount} 项 → 剩余 ${allFindings.length} 项`);
    }

    // ── Step 5: 生成综合评估意见 ──
    const step5Result = await runStep(5, '汇总报告',
      () => this.aiService.generateSummaryReport(projectInfo, allFindings));

    let score: number;
    let riskLevel: ReviewReport['riskLevel'];
    let assessment: string;
    let scoreBreakdown;

    if (!step5Result.skipped && step5Result.result) {
      const { suggestedScore, assessment: aiAssessment, scoreReason } = step5Result.result;
      scoreBreakdown = ScoringEngine.compute(allFindings, suggestedScore, scoreReason);
      score = ScoringEngine.getScore(scoreBreakdown);
      riskLevel = ScoringEngine.computeRiskLevel(score, allFindings);
      assessment = aiAssessment;
      steps[5].summary = `审核完成，综合评分：${score}（确定性引擎计算）`;
    } else {
      // 汇总步骤被跳过 —— 使用确定性引擎默认计算
      scoreBreakdown = ScoringEngine.compute(allFindings, 0, '汇总步骤已跳过');
      score = ScoringEngine.getScore(scoreBreakdown);
      riskLevel = ScoringEngine.computeRiskLevel(score, allFindings);
      assessment = `方案共发现 ${allFindings.length} 项问题。${ScoringEngine.summarize(scoreBreakdown)}请按严重程度优先整改。`;
      steps[5].summary = '汇总步骤已跳过，使用默认评分';
    }
    onProgress?.(steps[5]);

    const report: ReviewReport = {
      id: reportId,
      fileName,
      projectInfo,
      overallScore: score,
      riskLevel,
      steps,
      comprehensiveAssessment: assessment,
      scoreBreakdown,
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
    // 同步删除该报告关联的对话记录
    try {
      await fs.unlink(path.join(config.paths.reports, `${id}.chat.json`));
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
    // 同步删除该报告关联的方案原文向量
    try {
      await vectorStore.deleteSchemeByReportId(id);
    } catch (err: any) {
      console.error('[Review] 删除方案原文向量失败：', err.message);
    }
  }

  /**
   * 删除报告中的单条问题并重算分数（使用确定性引擎，与首次评分同一公式）
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

    // 使用确定性引擎重算评分（与首次评分使用同一公式，消除跳变）
    const scoreBreakdown = ScoringEngine.compute(
      allFindings,
      report.scoreBreakdown?.aiSuggestedScore,
      report.scoreBreakdown?.aiScoreReason,
    );
    const newScore = ScoringEngine.getScore(scoreBreakdown);
    const newRiskLevel = ScoringEngine.computeRiskLevel(newScore, allFindings);

    report.overallScore = newScore;
    report.riskLevel = newRiskLevel;
    report.scoreBreakdown = scoreBreakdown;
    report.comprehensiveAssessment = `方案共发现 ${allFindings.length} 项问题。${ScoringEngine.summarize(scoreBreakdown)}请按严重程度优先整改。`;

    // 保存更新后的报告
    await this.saveReport(report);
    return report;
  }

  /**
   * Finding 后处理：
   * 1. 排除含特定关键字的 finding（专家论证、嵌固深度、锚固长度、抗突涌验算、边坡稳定性验算等）
   * 2. 将所有图类问题（标题含图纸/平面图/剖面图/示意图/布置图/详图）合并为一项
   *
   * @param steps  审核步骤数组（会原地修改各步骤的 findings）
   * @returns 过滤+合并后的全部 findings
   */
  private filterAndMergeFindings(steps: StepResult[]): Finding[] {
    const diagramFindings: Finding[] = [];
    let firstDiagramStepIdx = -1;

    // 遍历所有步骤，分离普通 finding / 排除项 / 图类 finding
    for (let si = 0; si < steps.length; si++) {
      const step = steps[si];
      if (!step.findings || step.findings.length === 0) continue;

      const remaining: Finding[] = [];

      for (const finding of step.findings) {
        // 1. 排除含特定关键字的 finding
        const fullText = `${finding.title} ${finding.description} ${finding.category}`;
        if (ReviewService.EXCLUDE_KEYWORDS.some(kw => fullText.includes(kw))) {
          continue;
        }

        // 2. 收集图类问题（标题含图类关键字）
        if (ReviewService.DIAGRAM_KEYWORDS.some(kw => finding.title.includes(kw))) {
          if (firstDiagramStepIdx < 0) firstDiagramStepIdx = si;
          diagramFindings.push(finding);
        } else {
          remaining.push(finding);
        }
      }

      step.findings = remaining;
    }

    // 合并图类问题为一项（仅当有 2 项及以上时才合并）
    if (diagramFindings.length >= 2) {
      const severityOrder: Record<string, number> = { critical: 0, major: 1, minor: 2, info: 3 };
      const highestSeverity = diagramFindings.reduce(
        (highest, f) => (severityOrder[f.severity] < severityOrder[highest] ? f.severity : highest),
        diagramFindings[0].severity,
      );

      const diagramList = diagramFindings
        .map((f, i) => `${i + 1}. ${f.title}：${f.description}`)
        .join('\n');

      const recommendations = diagramFindings
        .filter(f => f.recommendation)
        .map(f => f.recommendation!)
        .join('；');

      const mergedFinding: Finding = {
        id: 'diagram-merged',
        stepName: diagramFindings[0].stepName,
        severity: highestSeverity as Finding['severity'],
        category: '完整性',
        title: `图纸/图件问题汇总（共 ${diagramFindings.length} 项）`,
        description: `方案中存在以下图纸/图件相关问题：\n${diagramList}`,
        recommendation: recommendations || '请补充完善相关图纸/图件。',
      };

      // 将合并后的 finding 放入第一个出现图类问题的步骤
      if (firstDiagramStepIdx >= 0) {
        steps[firstDiagramStepIdx].findings.push(mergedFinding);
      }
    } else if (diagramFindings.length === 1) {
      // 只有一项图类问题，无需合并，放回原步骤
      if (firstDiagramStepIdx >= 0) {
        steps[firstDiagramStepIdx].findings.push(diagramFindings[0]);
      }
    }

    // 更新步骤摘要并收集全部 findings
    const allFindings: Finding[] = [];
    for (const step of steps) {
      if (step.stepNumber >= 1 && step.stepNumber <= 4) {
        step.summary = `${step.stepName}完成，发现 ${step.findings.length} 项问题`;
      }
      allFindings.push(...step.findings);
    }

    return allFindings;
  }

  // 保留兼容方法：委托给 ScoringEngine
  calculateRiskLevel(score: number, findings: Finding[]): ReviewReport['riskLevel'] {
    return ScoringEngine.computeRiskLevel(score, findings);
  }

  /**
   * 获取报告关联的对话消息
   */
  async getChatMessages(reportId: string): Promise<ChatMessage[]> {
    try {
      const filePath = path.join(config.paths.reports, `${reportId}.chat.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as ChatMessage[];
    } catch {
      return [];
    }
  }

  /**
   * 保存报告关联的对话消息
   */
  async saveChatMessages(reportId: string, messages: ChatMessage[]): Promise<void> {
    await fs.mkdir(config.paths.reports, { recursive: true });
    const filePath = path.join(config.paths.reports, `${reportId}.chat.json`);
    await fs.writeFile(filePath, JSON.stringify(messages, null, 2), 'utf-8');
  }

  private async saveReport(report: ReviewReport): Promise<void> {
    await fs.mkdir(config.paths.reports, { recursive: true });
    const filePath = path.join(config.paths.reports, `${report.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
  }
}
