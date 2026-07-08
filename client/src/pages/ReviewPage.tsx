import React, { useState } from 'react';
import { useAppStore } from '../store';
import type { StepResult } from '../types';
import './ReviewPage.css';

const ReviewPage: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [completedReportId, setCompletedReportId] = useState<string | null>(null);
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

    const formData = new FormData();
    formData.append('file', file);

    const initialSteps: StepResult[] = [
      { stepNumber: 0, stepName: '提取基本信息', status: 'pending', findings: [] },
      { stepNumber: 1, stepName: '完整性检查', status: 'pending', findings: [] },
      { stepNumber: 2, stepName: '合规性检查', status: 'pending', findings: [] },
      { stepNumber: 3, stepName: '支护专项检查', status: 'pending', findings: [] },
      { stepNumber: 4, stepName: '地方法规审查', status: 'pending', findings: [] },
      { stepNumber: 5, stepName: '汇总报告', status: 'pending', findings: [] },
    ];
    updateReviewingSteps(initialSteps);

    try {
      // 1. 上传文件，获取 progressId
      const response = await fetch('/api/review/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`服务器错误: ${response.status}`);
      }

      const { progressId } = await response.json();

      // 2. 轮询进度
      const pollProgress = async () => {
        const progressRes = await fetch(`/api/review/progress/${progressId}`);
        const progress = await progressRes.json();

        if (progress.error) {
          throw new Error(progress.error);
        }

        // 更新步骤状态
        if (progress.steps && progress.steps.length > 0) {
          updateReviewingSteps((prev: StepResult[]) => {
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

        if (progress.status === 'completed') {
          // 审核完成，显示查看报告按钮
          setCompletedReportId(progress.reportId);
          setIsReviewing(false);
          return;
        }

        if (progress.status === 'error') {
          throw new Error(progress.error || '审核失败');
        }

        // 继续轮询
        setTimeout(pollProgress, 1000);
      };

      // 开始轮询
      pollProgress();
    } catch (err: any) {
      alert(`上传失败: ${err.message}`);
      setIsReviewing(false);
    }
  };

  return (
    <div className="review-page">
      <div className="page-header">
        <h1 className="page-title">方案审核</h1>
        <p className="page-subtitle">上传深基坑支护及土方开挖专项施工方案，AI 将自动进行多维度审查</p>
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
          <h2 className="progress-title">审核进行中...</h2>
          <div className="steps-list">
            {reviewingSteps.map(step => (
              <div key={step.stepNumber} className="step-item">
                <div className={`step-status-icon step-${step.status}`}>
                  {step.status === 'completed' && '✓'}
                  {step.status === 'running' && <div className="spinner spinner-dark" />}
                  {step.status === 'pending' && '·'}
                  {step.status === 'error' && '✕'}
                </div>
                <div className="step-content">
                  <div className="step-name">{step.stepName}</div>
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
