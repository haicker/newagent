import React, { useRef, useState } from 'react';
import { useAppStore } from '../store';
import { apiFetch } from '../api';
import type { StepResult } from '../types';
import './ReviewPage.css';

// ── SSE 稳定性参数 ──
const SSE_MAX_RETRIES = 3;        // SSE 断线最大重连次数
const SSE_RETRY_DELAY_MS = 2000;  // 重连基础延迟（指数退避）
const POLL_INTERVAL_MS = 2000;    // 降级轮询间隔

/** 处理一条进度快照，更新 UI 状态。返回 'completed' | 'error' | 'running' | 'paused' */
type ProgressStatus = 'completed' | 'error' | 'running' | 'paused';

function handleProgress(
  progress: any,
  updateReviewingSteps: (fn: (prev: StepResult[]) => StepResult[]) => void,
): ProgressStatus {
  if (progress.steps?.length > 0) {
    updateReviewingSteps((prev) => {
      const updated = [...prev];
      for (const step of progress.steps) {
        const idx = updated.findIndex(s => s.stepNumber === step.stepNumber);
        if (idx >= 0) {
          updated[idx] = step;
        }
      }
      return updated;
    });
  }

  if (progress.status === 'completed') return 'completed';
  if (progress.status === 'error') return 'error';
  if (progress.status === 'paused') return 'paused';
  return 'running';
}

/** 通过 SSE 接收进度推送（带自动重连）。resolve = 完成/出错，reject = 重试耗尽 */
async function consumeSSE(
  progressId: string,
  onProgress: (progress: any) => ProgressStatus,
  signal?: AbortSignal,
  onRetry?: (attempt: number, max: number) => void,
): Promise<ProgressStatus> {
  let lastStatus: ProgressStatus = 'running';

  for (let attempt = 0; attempt <= SSE_MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('已取消');

    try {
      const res = await apiFetch(`/api/review/progress/${progressId}/stream`);
      if (!res.ok || !res.body) {
        throw new Error(`SSE 连接失败 (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          if (signal?.aborted) {
            reader.cancel().catch(() => {});
            throw new Error('已取消');
          }
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const event of events) {
            // 取 data: 行（忽略 comment 行如 heartbeat）
            const line = event.split('\n').find(l => l.startsWith('data: '));
            if (!line) continue;

            const progress = JSON.parse(line.slice(6));
            lastStatus = onProgress(progress);

            if (lastStatus === 'completed' || lastStatus === 'error') {
              return lastStatus;
            }
            // 'paused' 和 'running' 不返回，继续监听
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      // 流正常结束但未收到 completed/error —— 可能是代理提前断连，重试
      if (attempt < SSE_MAX_RETRIES) {
        console.warn(`[SSE] 流意外结束，${SSE_RETRY_DELAY_MS * (attempt + 1)}ms 后重连 (attempt ${attempt + 1}/${SSE_MAX_RETRIES})`);
        onRetry?.(attempt + 1, SSE_MAX_RETRIES);
        await new Promise(r => setTimeout(r, SSE_RETRY_DELAY_MS * (attempt + 1)));
      }
    } catch (err: any) {
      if (signal?.aborted) throw err;
      if (attempt < SSE_MAX_RETRIES) {
        console.warn(`[SSE] 连接异常: ${err.message}，${SSE_RETRY_DELAY_MS * (attempt + 1)}ms 后重连 (attempt ${attempt + 1}/${SSE_MAX_RETRIES})`);
        onRetry?.(attempt + 1, SSE_MAX_RETRIES);
        await new Promise(r => setTimeout(r, SSE_RETRY_DELAY_MS * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }

  return lastStatus;
}

/** 降级轮询兜底 */
async function pollProgress(
  progressId: string,
  onProgress: (progress: any) => ProgressStatus,
  signal?: AbortSignal,
): Promise<ProgressStatus> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new Error('已取消');

    const res = await apiFetch(`/api/review/progress/${progressId}`);
    if (!res.ok) throw new Error(`轮询失败 (${res.status})`);
    const progress = await res.json();
    const status = onProgress(progress);

    if (status === 'completed' || status === 'error') return status;

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

const ReviewPage: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [completedReportId, setCompletedReportId] = useState<string | null>(null);
  const [connStatus, setConnStatus] = useState<'connected' | 'reconnecting' | 'polling'>('connected');
  const [reviewStatus, setReviewStatus] = useState<'running' | 'paused'>('running');
  const [controlLoading, setControlLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const progressIdRef = useRef<string | null>(null);
  const { reviewingSteps, isReviewing, updateReviewingSteps, setIsReviewing, resetReview, setCurrentPage, setViewingReportId } = useAppStore();

  const handleFileSelect = (selectedFile: File) => {
    if (selectedFile.type === 'application/pdf' ||
        selectedFile.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      setFile(selectedFile);
    } else {
      alert('只支持 PDF 和 DOCX 文件');
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    resetReview();
    setIsReviewing(true);
    setConnStatus('connected');
    setReviewStatus('running');

    const abortController = new AbortController();
    abortRef.current = abortController;

    const initialSteps: StepResult[] = [
      { stepNumber: 0, stepName: '提取基本信息', status: 'pending', findings: [] },
      { stepNumber: 1, stepName: '完整性检查', status: 'pending', findings: [] },
      { stepNumber: 2, stepName: '合规性检查', status: 'pending', findings: [] },
      { stepNumber: 3, stepName: '支护专项检查', status: 'pending', findings: [] },
      { stepNumber: 4, stepName: '地方法规审查', status: 'pending', findings: [] },
      { stepNumber: 5, stepName: '汇总报告', status: 'pending', findings: [] },
    ];
    updateReviewingSteps(initialSteps);

    let resultReportId: string | null = null;
    let resultError: string | null = null;

    const onProgress = (progress: any): ProgressStatus => {
      if (progress.reportId) resultReportId = progress.reportId;
      if (progress.error) resultError = progress.error;
      const status = handleProgress(progress, updateReviewingSteps);
      // 同步审核状态到 UI
      if (status === 'paused') setReviewStatus('paused');
      else if (status === 'running') setReviewStatus('running');
      return status;
    };

    try {
      // 1. 上传文件，获取 progressId
      const formData = new FormData();
      formData.append('file', file);

      const response = await apiFetch('/api/review/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`服务器错误: ${response.status}`);
      }

      const { progressId } = await response.json();
      progressIdRef.current = progressId;

      // 2. 优先通过 SSE 接收进度（带自动重连）
      let finalStatus: ProgressStatus;
      try {
        setConnStatus('connected');
        finalStatus = await consumeSSE(
          progressId,
          onProgress,
          abortController.signal,
          () => setConnStatus('reconnecting'),
        );
      } catch (sseErr: any) {
        if (abortController.signal.aborted) throw sseErr;

        // 3. SSE 重连耗尽 → 降级轮询
        console.warn(`[SSE] 重连耗尽，降级轮询: ${sseErr.message}`);
        setConnStatus('polling');
        finalStatus = await pollProgress(progressId, onProgress, abortController.signal);
      }

      if (finalStatus === 'completed') {
        setCompletedReportId(resultReportId);
        setIsReviewing(false);
      } else if (finalStatus === 'error') {
        throw new Error(resultError || '审核失败');
      }
    } catch (err: any) {
      if (abortController.signal.aborted) return;
      alert(`上传失败: ${err.message}`);
      setIsReviewing(false);
    } finally {
      abortRef.current = null;
      progressIdRef.current = null;
    }
  };

  // ── 控制按钮处理函数 ──
  const callControl = async (action: 'pause' | 'resume' | 'skip' | 'retry' | 'abort') => {
    const pid = progressIdRef.current;
    if (!pid) return;
    setControlLoading(true);
    try {
      await apiFetch(`/api/review/progress/${pid}/${action}`, { method: 'POST' });
    } catch (err: any) {
      console.error(`控制操作失败 (${action}):`, err.message);
    } finally {
      setControlLoading(false);
    }
  };

  const handlePause = () => callControl('pause');
  const handleResume = () => callControl('resume');
  const handleSkip = () => callControl('skip');
  const handleRetry = () => callControl('retry');

  const handleCancel = async () => {
    abortRef.current?.abort();
    await callControl('abort');
    setIsReviewing(false);
    resetReview();
  };

  const connStatusText: Record<string, string> = {
    connected: '',
    reconnecting: '正在重连...',
    polling: '网络不稳定，已切换到轮询模式',
  };

  // 当前是否有步骤出错（用于显示重试/跳过按钮）
  const hasErrorStep = reviewingSteps.some(s => s.status === 'error');

  return (
    <div className="review-page">
      <div className="page-header">
        <h1 className="page-title">方案审核</h1>
        <p className="page-subtitle">
          上传深基坑支护及土方开挖专项施工方案，<br />
          AI 将自动进行多维度审查
        </p>
      </div>

      {!isReviewing && (
        <div className="card upload-card">
          <div
            className={`upload-zone ${isDragging ? 'dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <div className="upload-icon">📄</div>
            <p className="upload-text">
              {file ? file.name : '拖拽文件到此处，或点击选择文件'}
            </p>
            <p className="upload-hint">支持 PDF 和 DOCX 格式</p>
            <input
              type="file"
              accept=".pdf,.docx"
              onChange={(e) => e.target.files && handleFileSelect(e.target.files[0])}
              style={{ display: 'none' }}
              id="file-input"
            />
            <label htmlFor="file-input" className="btn btn-ghost" style={{ marginTop: 16 }}>
              选择文件
            </label>
          </div>

          {file && (
            <div className="upload-actions">
              <button className="btn btn-primary" onClick={handleUpload}>
                开始审核
              </button>
              <button className="btn btn-ghost" onClick={() => setFile(null)}>
                取消
              </button>
            </div>
          )}
        </div>
      )}

      {isReviewing && (
        <div className="card review-progress">
          <div className="progress-header">
            <h2 className="progress-title">
              {reviewStatus === 'paused' ? '审核已暂停' : '审核进行中...'}
            </h2>
            <div className="review-controls">
              {reviewStatus === 'running' && (
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 13 }}
                  onClick={handlePause}
                  disabled={controlLoading}
                >
                  暂停
                </button>
              )}
              {reviewStatus === 'paused' && !hasErrorStep && (
                <button
                  className="btn btn-primary"
                  style={{ fontSize: 13 }}
                  onClick={handleResume}
                  disabled={controlLoading}
                >
                  继续审核
                </button>
              )}
              {hasErrorStep && (
                <>
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: 13 }}
                    onClick={handleRetry}
                    disabled={controlLoading}
                  >
                    重试此步骤
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 13 }}
                    onClick={handleSkip}
                    disabled={controlLoading}
                  >
                    跳过此步骤
                  </button>
                </>
              )}
              <button
                className="btn btn-ghost"
                style={{ fontSize: 13, color: '#dc2626' }}
                onClick={handleCancel}
                disabled={controlLoading}
              >
                取消审核
              </button>
            </div>
          </div>

          {connStatusText[connStatus] && (
            <div className="conn-status-banner">{connStatusText[connStatus]}</div>
          )}

          {reviewStatus === 'paused' && !hasErrorStep && (
            <div className="conn-status-banner" style={{ background: '#eff6ff', borderColor: '#93c5fd', color: '#1e40af' }}>
              审核已暂停，点击"继续审核"恢复执行
            </div>
          )}

          {hasErrorStep && (
            <div className="conn-status-banner" style={{ background: '#fef2f2', borderColor: '#fca5a5', color: '#991b1b' }}>
              审核步骤执行失败，可选择"重试此步骤"或"跳过此步骤"继续审核
            </div>
          )}

          <div className="steps-list">
            {reviewingSteps.map(step => (
              <div key={step.stepNumber} className={`step-item ${step.status === 'running' ? 'step-item-running' : ''}`}>
                <div className={`step-status-icon step-${step.status}`}>
                  {step.status === 'completed' && '✓'}
                  {step.status === 'running' && <div className="spinner spinner-dark" />}
                  {step.status === 'pending' && '·'}
                  {step.status === 'error' && '✕'}
                  {step.status === 'skipped' && '⊘'}
                </div>
                <div className="step-content">
                  <div className="step-row">
                    <div className="step-name">{step.stepName}</div>
                    {step.status === 'running' && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={handleSkip}
                        disabled={controlLoading}
                      >
                        跳过
                      </button>
                    )}
                  </div>
                  {step.summary && <div className="step-summary">{step.summary}</div>}
                  {step.error && <div className="step-error">{step.error}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {completedReportId && !isReviewing && (
        <div className="card review-complete">
          <div className="complete-icon">✅</div>
          <h2 className="complete-title">审核完成！</h2>
          <p className="complete-text">您的深基坑支护方案审核已完成，点击下方按钮查看详细报告。</p>
          <div className="complete-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                setViewingReportId(completedReportId);
                setCurrentPage('reports');
              }}
            >
              查看报告
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setCompletedReportId(null);
                setFile(null);
                resetReview();
              }}
            >
              继续审核其他方案
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReviewPage;
