import React, { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppStore } from '../store';
import { apiFetch } from '../api';
import type { ReportSummary, ReviewReport, Finding, ChatMessage } from '../types';
import './ReportsPage.css';

const ReportsPage: React.FC = () => {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReviewReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'findings' | 'chat'>('overview');
  const { viewingReportId, setViewingReportId } = useAppStore();

  const loadReports = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/review/reports');
      const data = await res.json();
      setReports(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReports();
  }, []);

  const openReport = useCallback(async (id: string) => {
    const res = await apiFetch(`/api/review/reports/${id}`);
    const data = await res.json();
    setSelectedReport(data);
    setChatMessages([]);
    setActiveTab('overview');
  }, []);

  // 从其他页面跳转过来时自动打开指定报告
  useEffect(() => {
    if (viewingReportId) {
      openReport(viewingReportId);
      setViewingReportId(null); // 清除，避免重复触发
    }
  }, [viewingReportId, openReport, setViewingReportId]);

  const deleteReport = async (id: string) => {
    if (!confirm('确定删除此报告？')) return;
    await apiFetch(`/api/review/reports/${id}`, { method: 'DELETE' });
    if (selectedReport?.id === id) setSelectedReport(null);
    loadReports();
  };

  const deleteFinding = async (findingId: string) => {
    if (!selectedReport) return;
    if (!confirm('确定删除该问题条目？删除后将重新计算分数。')) return;
    try {
      const res = await apiFetch(`/api/review/reports/${selectedReport.id}/findings/${findingId}`, {
        method: 'DELETE',
      });
      const updated: ReviewReport = await res.json();
      setSelectedReport(updated);
    } catch (e) {
      console.error('删除问题条目失败:', e);
    }
  };

  const sendChat = async () => {
    if (!chatInput.trim() || !selectedReport) return;
    const userMsg: ChatMessage = { role: 'user', content: chatInput, timestamp: new Date().toISOString() };
    setChatMessages(prev => [...prev, userMsg]);
    setChatInput('');
    setChatLoading(true);
    try {
      const res = await apiFetch('/api/review/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId: selectedReport.id, message: chatInput, history: chatMessages }),
      });
      const data = await res.json();
      const assistantMsg: ChatMessage = { role: 'assistant', content: data.answer, timestamp: new Date().toISOString() };
      setChatMessages(prev => [...prev, assistantMsg]);
    } catch (e) {
      console.error(e);
    } finally {
      setChatLoading(false);
    }
  };

  const getRiskLabel = (level: string) => {
    const map: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险', critical: '严重风险' };
    return map[level] || level;
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return '#16a34a';
    if (score >= 60) return '#ca8a04';
    if (score >= 40) return '#d97706';
    return '#dc2626';
  };

  const allFindings: Finding[] = selectedReport?.steps.flatMap(s => s.findings) || [];

  return (
    <div className="reports-page">
      <div className={`reports-list ${selectedReport ? 'has-detail' : ''}`}>
        <div className="list-header">
          <h2 className="page-title">历史报告</h2>
          <button className="btn btn-ghost" onClick={loadReports} style={{ fontSize: 13 }}>刷新</button>
        </div>

        {loading && <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>加载中...</div>}

        {!loading && reports.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <div className="empty-state-text">暂无审核报告</div>
          </div>
        )}

        <div className="report-cards">
          {reports.map(r => (
            <div
              key={r.id}
              className={`report-card ${selectedReport?.id === r.id ? 'selected' : ''}`}
              onClick={() => openReport(r.id)}
            >
              <div className="report-card-header">
                <div className="report-score-mini" style={{ color: getScoreColor(r.overallScore) }}>
                  {r.overallScore}分
                </div>
                <span className={`severity-badge severity-${r.riskLevel === 'low' ? 'info' : r.riskLevel === 'medium' ? 'minor' : r.riskLevel === 'high' ? 'major' : 'critical'}`}>
                  {getRiskLabel(r.riskLevel)}
                </span>
              </div>
              <div className="report-project-name">{r.projectName}</div>
              <div className="report-file-name">{r.fileName}</div>
              <div className="report-date">{new Date(r.createdAt).toLocaleString('zh-CN')}</div>
              <button
                className="btn btn-danger"
                style={{ fontSize: 12, padding: '4px 10px', marginTop: 8 }}
                onClick={(e) => { e.stopPropagation(); deleteReport(r.id); }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      </div>

      {selectedReport && (
        <div className="report-detail">
          <div className="detail-header">
            <button className="detail-back-btn" onClick={() => setSelectedReport(null)}>
              ← 返回列表
            </button>
            <div className="detail-score-wrap">
              <div className="score-circle" style={{
                borderColor: getScoreColor(selectedReport.overallScore),
                color: getScoreColor(selectedReport.overallScore)
              }}>
                <span className="score-value">{selectedReport.overallScore}</span>
                <span className="score-label">评分</span>
              </div>
              <div>
                <h2 className="detail-project-name">{selectedReport.projectInfo.projectName}</h2>
                <p className="detail-file">{selectedReport.fileName}</p>
                <span className={`severity-badge severity-${selectedReport.riskLevel === 'low' ? 'info' : selectedReport.riskLevel === 'medium' ? 'minor' : selectedReport.riskLevel === 'high' ? 'major' : 'critical'}`}>
                  {getRiskLabel(selectedReport.riskLevel)}
                </span>
              </div>
            </div>
          </div>

          <div className="detail-tabs">
            {(['overview', 'findings', 'chat'] as const).map(tab => (
              <button
                key={tab}
                className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'overview' ? '概览' : tab === 'findings' ? `问题清单 (${allFindings.length})` : '专家对话'}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && (
            <div className="detail-overview">
              <div className="info-grid">
                <InfoItem label="工程名称" value={selectedReport.projectInfo.projectName} />
                <InfoItem label="省市" value={`${selectedReport.projectInfo.province} ${selectedReport.projectInfo.city}`} />
                <InfoItem label="支护形式" value={selectedReport.projectInfo.supportType} />
                <InfoItem label="开挖深度" value={`${selectedReport.projectInfo.excavationDepth} m`} />
                <InfoItem label="地质情况" value={selectedReport.projectInfo.geologicalConditions} />
                <InfoItem label="地下水" value={selectedReport.projectInfo.groundwater} />
              </div>

              <div className="assessment-box">
                <h3>综合评估意见</h3>
                <p>{selectedReport.comprehensiveAssessment}</p>
              </div>

              <h3 style={{ marginBottom: 12, color: '#1a3a5c' }}>审核步骤</h3>
              <div className="steps-summary">
                {selectedReport.steps.map(step => (
                  <div key={step.stepNumber} className="step-summary-item">
                    <div className={`step-status-icon step-${step.status}`}>✓</div>
                    <div>
                      <div className="step-name">{step.stepName}</div>
                      <div className="step-summary-text">{step.summary}</div>
                      {step.findings.length > 0 && (
                        <div className="findings-count">
                          {step.findings.filter(f => f.severity === 'critical').length > 0 && (
                            <span className="severity-badge severity-critical">{step.findings.filter(f => f.severity === 'critical').length} 严重</span>
                          )}
                          {step.findings.filter(f => f.severity === 'major').length > 0 && (
                            <span className="severity-badge severity-major">{step.findings.filter(f => f.severity === 'major').length} 重要</span>
                          )}
                          {step.findings.filter(f => f.severity === 'minor').length > 0 && (
                            <span className="severity-badge severity-minor">{step.findings.filter(f => f.severity === 'minor').length} 一般</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'findings' && (
            <div className="findings-list">
              {allFindings.length === 0 && (
                <div className="empty-state" style={{ padding: 40 }}>
                  <div className="empty-state-icon">✅</div>
                  <div className="empty-state-text">未发现问题</div>
                </div>
              )}
              {(['critical', 'major', 'minor'] as const).map(severity => {
                const group = allFindings.filter(f => f.severity === severity);
                if (group.length === 0) return null;
                const labels: Record<string, string> = { critical: '严重问题', major: '重要问题', minor: '一般问题' };
                return (
                  <div key={severity} className="findings-group">
                    <h3 className={`findings-group-title severity-${severity}`}>{labels[severity]} ({group.length})</h3>
                    {group.map(finding => (
                      <div key={finding.id} className={`finding-item border-${severity}`}>
                        <div className="finding-header">
                          <span className={`severity-badge severity-${severity}`}>{finding.category}</span>
                          <span className="finding-title">{finding.title}</span>
                          <button
                            className="finding-delete-btn"
                            title="删除此问题条目"
                            onClick={() => deleteFinding(finding.id)}
                          >
                            ×
                          </button>
                        </div>
                        <p className="finding-description">{finding.description}</p>
                        {finding.location && <p className="finding-location">位置: {finding.location}</p>}
                        {finding.recommendation && (
                          <div className="finding-recommendation">
                            <strong>整改建议:</strong> {finding.recommendation}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'chat' && (
            <div className="chat-container">
              <div className="chat-messages">
                {chatMessages.length === 0 && (
                  <div className="chat-hint">
                    <p>可以向专家询问审核报告中的相关问题，例如：</p>
                    <ul>
                      <li>严重问题的具体整改方案是什么？</li>
                      <li>支护结构的关键参数怎么核查？</li>
                      <li>本项目最大的安全风险是什么？</li>
                    </ul>
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`chat-bubble ${msg.role}`}>
                    <div className="chat-role">{msg.role === 'user' ? '我' : '专家'}</div>
                    {msg.role === 'assistant' ? (
                      <div className="chat-content markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <div className="chat-content">{msg.content}</div>
                    )}
                  </div>
                ))}
                {chatLoading && (
                  <div className="chat-bubble assistant">
                    <div className="chat-role">专家</div>
                    <div className="chat-content"><div className="spinner spinner-dark" /></div>
                  </div>
                )}
              </div>
              <div className="chat-input-bar">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="输入问题..."
                  rows={2}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                />
                <button className="btn btn-primary" onClick={sendChat} disabled={chatLoading || !chatInput.trim()}>
                  发送
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const InfoItem: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="info-item">
    <span className="info-label">{label}</span>
    <span className="info-value">{value || '-'}</span>
  </div>
);

export default ReportsPage;
