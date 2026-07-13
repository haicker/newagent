import { config } from '../config.js';
import type { Finding, ScoreBreakdown, DeductionGroup, ReviewReport } from '../../shared/types.js';

/**
 * 确定性评分引擎
 *
 * 核心原则：
 * 1. 最终分由确定性公式计算，AI 不参与最终评分
 * 2. 每条 finding 按严重度绑定可配置扣分权重
 * 3. 无论首次评分还是删除 finding 后重算，使用同一公式，消除跳变
 * 4. 扣分明细记录在 ScoreBreakdown 中，可追溯、可解释
 */
export class ScoringEngine {

  /**
   * 计算 findings 的确定性评分
   *
   * @param findings  全部 findings
   * @param aiSuggestedScore  AI 建议分（可选，仅记录不参与计算）
   * @param aiScoreReason  AI 建议分理由（可选）
   * @returns ScoreBreakdown  含扣分明细的评分结果
   */
  static compute(
    findings: Finding[],
    aiSuggestedScore?: number,
    aiScoreReason?: string,
  ): ScoreBreakdown {
    const { baseScore, minScore, weights } = config.scoring;

    // 按严重度分组统计
    const severities: DeductionGroup['severity'][] = ['critical', 'major', 'minor', 'info'];
    const deductions: DeductionGroup[] = severities
      .map(severity => {
        const count = findings.filter(f => f.severity === severity).length;
        const weightPerItem = weights[severity];
        const totalDeduction = count * weightPerItem;
        return { severity, count, weightPerItem, totalDeduction };
      })
      // 只保留有 finding 的组（count > 0），减少存储噪声
      .filter(g => g.count > 0);

    const totalDeduction = deductions.reduce((sum, g) => sum + g.totalDeduction, 0);
    const finalScore = Math.max(minScore, baseScore - totalDeduction);

    return {
      baseScore,
      deductions,
      totalDeduction,
      finalScore,
      aiSuggestedScore,
      aiScoreReason,
    };
  }

  /**
   * 从 ScoreBreakdown 获取最终分（0-100 整数）
   */
  static getScore(breakdown: ScoreBreakdown): number {
    return breakdown.finalScore;
  }

  /**
   * 根据评分和 findings 计算风险等级
   * 规则：有 critical finding 或 score < critical 阈值 → critical
   *       score < high 阈值 → high
   *       score < medium 阈值 → medium
   *       否则 → low
   */
  static computeRiskLevel(
    score: number,
    findings: Finding[],
  ): ReviewReport['riskLevel'] {
    const { riskThresholds } = config.scoring;
    const hasCritical = findings.some(f => f.severity === 'critical');

    if (hasCritical || score < riskThresholds.critical) return 'critical';
    if (score < riskThresholds.high) return 'high';
    if (score < riskThresholds.medium) return 'medium';
    return 'low';
  }

  /**
   * 生成评分摘要文本（用于步骤 summary 和报告综合评估的兜底）
   */
  static summarize(breakdown: ScoreBreakdown): string {
    const parts: string[] = [];
    for (const g of breakdown.deductions) {
      const label = this.severityLabel(g.severity);
      parts.push(`${label} ${g.count} 项（每项扣 ${g.weightPerItem} 分，共扣 ${g.totalDeduction} 分）`);
    }
    const detail = parts.length > 0 ? parts.join('；') : '未发现扣分项';
    return `基础分 ${breakdown.baseScore}，总扣分 ${breakdown.totalDeduction}，最终得分 ${breakdown.finalScore}。${detail}。`;
  }

  private static severityLabel(severity: string): string {
    const map: Record<string, string> = {
      critical: '严重',
      major: '重要',
      minor: '一般',
      info: '提示',
    };
    return map[severity] || severity;
  }
}
