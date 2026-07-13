import puppeteer from 'puppeteer';
import type { ReviewReport, Finding, ScoreBreakdown } from '../../shared/types.js';

/**
 * 报告 PDF 导出服务
 * 使用 Puppeteer 将 HTML 模板渲染为 PDF
 */
export class PdfService {

  /**
   * 将审核报告渲染为 PDF Buffer
   */
  async generatePdf(report: ReviewReport): Promise<Buffer> {
    const html = this.buildHtml(report);
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' },
      });
      return Buffer.from(pdfBuffer);
    } finally {
      await browser.close();
    }
  }

  /**
   * 构建报告 HTML 模板
   */
  private buildHtml(report: ReviewReport): string {
    const riskLabels: Record<string, string> = {
      low: '低风险', medium: '中风险', high: '高风险', critical: '严重风险',
    };
    const riskColors: Record<string, string> = {
      low: '#16a34a', medium: '#ca8a04', high: '#d97706', critical: '#dc2626',
    };
    const severityLabels: Record<string, string> = {
      critical: '严重', major: '重要', minor: '一般', info: '提示',
    };
    const severityColors: Record<string, string> = {
      critical: '#dc2626', major: '#d97706', minor: '#2563eb', info: '#6b7280',
    };

    const allFindings: Finding[] = report.steps.flatMap(s => s.findings);
    const scoreColor = this.getScoreColor(report.overallScore);

    // 项目信息行
    const infoRows = [
      ['工程名称', report.projectInfo.projectName, '省市', `${report.projectInfo.province} ${report.projectInfo.city}`],
      ['支护形式', report.projectInfo.supportType, '开挖深度', `${report.projectInfo.excavationDepth} m`],
      ['地质情况', report.projectInfo.geologicalConditions, '地下水情况', report.projectInfo.groundwater],
      ['周边环境', report.projectInfo.surroundingEnvironment, '方案文件', report.fileName],
    ].map(row => `
      <tr>
        <td class="label">${row[0]}</td>
        <td>${this.escape(row[1])}</td>
        <td class="label">${row[2]}</td>
        <td>${this.escape(row[3])}</td>
      </tr>`).join('');

    // 审核步骤
    const stepsHtml = report.steps
      .filter(s => s.stepNumber > 0)
      .map(step => {
        const critical = step.findings.filter(f => f.severity === 'critical').length;
        const major = step.findings.filter(f => f.severity === 'major').length;
        const minor = step.findings.filter(f => f.severity === 'minor').length;
        const badges: string[] = [];
        if (critical) badges.push(`<span class="badge badge-critical">${critical} 严重</span>`);
        if (major) badges.push(`<span class="badge badge-major">${major} 重要</span>`);
        if (minor) badges.push(`<span class="badge badge-minor">${minor} 一般</span>`);
        if (badges.length === 0) badges.push(`<span class="badge badge-ok">无问题</span>`);

        return `
        <div class="step-item">
          <div class="step-num">${step.stepNumber}</div>
          <div class="step-body">
            <div class="step-title">${this.escape(step.stepName)}</div>
            <div class="step-summary">${this.escape(step.summary || '')}</div>
            <div class="step-badges">${badges.join(' ')}</div>
          </div>
        </div>`;
      }).join('');

    // 问题清单（按严重程度分组）
    const findingsHtml = (['critical', 'major', 'minor'] as const)
      .map(severity => {
        const group = allFindings.filter(f => f.severity === severity);
        if (group.length === 0) return '';
        const color = severityColors[severity];
        const label = severityLabels[severity];
        const items = group.map((f, idx) => `
          <div class="finding-card" style="border-left-color:${color}">
            <div class="finding-head">
              <span class="finding-cat" style="background:${color}">${this.escape(f.category)}</span>
              <span class="finding-num">${idx + 1}.</span>
              <span class="finding-title">${this.escape(f.title)}</span>
            </div>
            <p class="finding-desc">${this.escape(f.description)}</p>
            ${f.location ? `<p class="finding-loc">位置：${this.escape(f.location)}</p>` : ''}
            ${f.recommendation ? `<div class="finding-rec"><strong>整改建议：</strong>${this.escape(f.recommendation)}</div>` : ''}
          </div>`).join('');

        return `
        <div class="finding-group">
          <h3 style="color:${color}">${label}问题（${group.length}）</h3>
          ${items}
        </div>`;
      }).join('');

    const createdDate = new Date(report.createdAt).toLocaleString('zh-CN');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "SimSun", sans-serif;
    color: #1f2937;
    font-size: 14px;
    line-height: 1.6;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 20px;
    border-bottom: 3px solid #2563a8;
    margin-bottom: 24px;
  }
  .header h1 {
    font-size: 22px;
    color: #1a3a5c;
  }
  .header .subtitle {
    font-size: 12px;
    color: #9ca3af;
    margin-top: 4px;
  }
  .score-box {
    text-align: center;
    border: 3px solid ${scoreColor};
    border-radius: 50%;
    width: 80px;
    height: 80px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    flex-shrink: 0;
  }
  .score-box .score-val {
    font-size: 28px;
    font-weight: 700;
    color: ${scoreColor};
    line-height: 1;
  }
  .score-box .score-lbl {
    font-size: 11px;
    color: ${scoreColor};
    margin-top: 2px;
  }

  .risk-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-radius: 8px;
    background: ${riskColors[report.riskLevel]}15;
    border-left: 4px solid ${riskColors[report.riskLevel]};
    margin-bottom: 24px;
  }
  .risk-banner .risk-tag {
    background: ${riskColors[report.riskLevel]};
    color: white;
    padding: 2px 12px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 600;
  }
  .risk-banner .risk-text {
    font-size: 13px;
    color: #374151;
  }

  h2 {
    font-size: 16px;
    color: #1a3a5c;
    margin-top: 24px;
    margin-bottom: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid #e5e7eb;
  }

  table.info-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 8px;
  }
  table.info-table td {
    border: 1px solid #e5e7eb;
    padding: 8px 12px;
    font-size: 13px;
  }
  table.info-table td.label {
    background: #f9fafb;
    color: #6b7280;
    font-weight: 600;
    width: 12%;
  }

  .assessment-box {
    background: #f0f7ff;
    border-left: 4px solid #2563a8;
    padding: 14px 16px;
    border-radius: 0 8px 8px 0;
    margin-bottom: 8px;
  }
  .assessment-box p {
    font-size: 13px;
    color: #374151;
    line-height: 1.7;
    white-space: pre-wrap;
  }

  .step-item {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
  }
  .step-num {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #2563a8;
    color: white;
    font-weight: 700;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .step-body { flex: 1; }
  .step-title { font-weight: 600; font-size: 14px; color: #1f2937; }
  .step-summary { font-size: 13px; color: #6b7280; margin-top: 2px; }
  .step-badges { margin-top: 4px; }

  .badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 4px;
    font-size: 12px;
    margin-right: 4px;
    color: white;
  }
  .badge-critical { background: #dc2626; }
  .badge-major { background: #d97706; }
  .badge-minor { background: #2563eb; }
  .badge-ok { background: #16a34a; }

  .finding-group { margin-bottom: 20px; }
  .finding-card {
    border-left: 3px solid #ddd;
    background: #fafafa;
    border-radius: 0 6px 6px 0;
    padding: 12px 14px;
    margin-bottom: 10px;
  }
  .finding-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .finding-cat {
    color: white;
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .finding-num { font-weight: 600; color: #6b7280; font-size: 13px; }
  .finding-title { font-weight: 600; font-size: 14px; color: #1f2937; }
  .finding-desc { font-size: 13px; color: #4b5563; line-height: 1.5; margin-bottom: 4px; }
  .finding-loc { font-size: 12px; color: #9ca3af; margin-bottom: 4px; }
  .finding-rec {
    font-size: 13px;
    color: #374151;
    background: #f0fdf4;
    padding: 6px 10px;
    border-radius: 4px;
    line-height: 1.5;
  }

  /* 评分明细 */
  .deduct-card {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 14px;
    margin-bottom: 8px;
  }
  .deduct-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    color: #6b7280;
    margin-bottom: 12px;
    padding: 8px 12px;
    background: white;
    border-radius: 6px;
  }
  .deduct-summary strong { color: #1f2937; font-size: 16px; }
  .deduct-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-bottom: 8px;
  }
  .deduct-table th {
    background: #e5e7eb;
    color: #374151;
    font-weight: 600;
    text-align: center;
    padding: 5px 8px;
    border: 1px solid #d1d5db;
  }
  .deduct-table td {
    text-align: center;
    padding: 5px 8px;
    border: 1px solid #e5e7eb;
    color: #374151;
  }
  .deduct-sev-tag {
    display: inline-block;
    color: white;
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 4px;
  }
  .deduct-ai-suggest {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 6px 10px;
    background: #fef3c7;
    border-radius: 4px;
    font-size: 12px;
  }
  .deduct-ai-label { color: #92400e; font-weight: 600; }
  .deduct-ai-score { color: #92400e; font-weight: 700; font-size: 15px; }
  .deduct-ai-reason { color: #a16207; }

  .footer {
    margin-top: 32px;
    padding-top: 12px;
    border-top: 1px solid #e5e7eb;
    text-align: center;
    font-size: 11px;
    color: #9ca3af;
  }

  @page { margin: 0; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>深基坑支护方案审核报告</h1>
      <div class="subtitle">生成时间：${createdDate}</div>
    </div>
    <div class="score-box">
      <div class="score-val">${report.overallScore}</div>
      <div class="score-lbl">综合评分</div>
    </div>
  </div>

  <div class="risk-banner">
    <span class="risk-tag">${riskLabels[report.riskLevel]}</span>
    <span class="risk-text">共发现 ${allFindings.length} 项问题，其中
      严重 ${allFindings.filter(f => f.severity === 'critical').length} 项，
      重要 ${allFindings.filter(f => f.severity === 'major').length} 项，
      一般 ${allFindings.filter(f => f.severity === 'minor').length} 项
    </span>
  </div>

  <h2>一、项目基本信息</h2>
  <table class="info-table">
    <tbody>${infoRows}</tbody>
  </table>

  <h2>二、综合评估意见</h2>
  <div class="assessment-box">
    <p>${this.escape(report.comprehensiveAssessment)}</p>
  </div>

  ${report.scoreBreakdown ? this.buildScoreBreakdownHtml(report.scoreBreakdown) : ''}

  <h2>三、审核步骤</h2>
  ${stepsHtml}

  <h2>四、问题清单</h2>
  ${allFindings.length === 0
    ? '<div style="text-align:center;padding:20px;color:#16a34a;">✅ 未发现问题</div>'
    : findingsHtml}

  <div class="footer">
    本报告由 AI 深基坑支护方案审核系统自动生成 · ${createdDate}
  </div>
</body>
</html>`;
  }

  private getScoreColor(score: number): string {
    if (score >= 80) return '#16a34a';
    if (score >= 60) return '#ca8a04';
    if (score >= 40) return '#d97706';
    return '#dc2626';
  }

  private buildScoreBreakdownHtml(breakdown: ScoreBreakdown): string {
    const sevLabels: Record<string, string> = { critical: '严重', major: '重要', minor: '一般', info: '提示' };
    const sevColors: Record<string, string> = { critical: '#dc2626', major: '#d97706', minor: '#2563eb', info: '#6b7280' };

    const rows = breakdown.deductions.map(g => `
      <tr>
        <td><span class="deduct-sev-tag" style="background:${sevColors[g.severity] || '#6b7280'}">${sevLabels[g.severity] || g.severity}</span></td>
        <td>${g.count}</td>
        <td>-${g.weightPerItem}</td>
        <td style="color:#dc2626;font-weight:600">-${g.totalDeduction}</td>
      </tr>`).join('');

    const noDeduction = breakdown.deductions.length === 0
      ? '<div style="text-align:center;padding:8px;color:#16a34a;">无扣分项</div>'
      : '';

    const aiSuggest = breakdown.aiSuggestedScore !== undefined && breakdown.aiSuggestedScore > 0
      ? `<div class="deduct-ai-suggest">
          <span class="deduct-ai-label">AI 建议分（仅参考）:</span>
          <span class="deduct-ai-score">${breakdown.aiSuggestedScore}</span>
          ${breakdown.aiScoreReason ? `<span class="deduct-ai-reason">${this.escape(breakdown.aiScoreReason)}</span>` : ''}
        </div>`
      : '';

    return `
  <h2>评分明细</h2>
  <div class="deduct-card">
    <div class="deduct-summary">
      <span>基础分</span><strong>${breakdown.baseScore}</strong>
      <span>−</span><strong style="color:#dc2626">${breakdown.totalDeduction}</strong>
      <span>=</span><strong style="color:#16a34a;font-size:18px;">${breakdown.finalScore}</strong>
    </div>
    ${rows ? `<table class="deduct-table"><thead><tr><th>严重度</th><th>数量</th><th>每条扣分</th><th>小计</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    ${noDeduction}
    ${aiSuggest}
  </div>`;
  }

  private escape(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, c => map[c]);
  }
}
