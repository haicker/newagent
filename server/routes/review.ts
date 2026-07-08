import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import { config } from '../config.js';
import { ReviewService } from '../services/reviewService.js';
import { AIService } from '../services/aiService.js';
import { vectorStore } from '../services/vectorStore.js';
import type { ChatRequest, StepResult } from '../../shared/types.js';

const router = Router();
const reviewService = new ReviewService();
const aiService = new AIService();

// 存储审核进度（内存中）
const reviewProgress = new Map<string, {
  reportId?: string;
  steps: StepResult[];
  status: 'running' | 'completed' | 'error';
  error?: string;
  fileName: string;
}>();

// 修复中文文件名乱码
function decodeFileName(name: string): string {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// 配置 multer 文件上传
const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.mkdir(config.paths.uploads, { recursive: true });
    cb(null, config.paths.uploads);
  },
  filename: (_req, file, cb) => {
    const decodedName = decodeFileName(file.originalname);
    const uniqueName = `${Date.now()}-${decodedName}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (config.upload.allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('只支持 PDF 和 DOCX 文件'));
    }
  },
});

/**
 * POST /api/review/upload
 * 上传方案文件并启动审核（异步，通过轮询获取进度）
 */
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: '请上传文件' });
    return;
  }

  const decodedName = decodeFileName(req.file.originalname);
  const progressId = `review-${Date.now()}`;
  reviewProgress.set(progressId, {
    status: 'running',
    steps: [],
    fileName: decodedName,
  });

  // 立即返回 progressId，前端通过轮询获取进度
  res.json({ progressId, fileName: decodedName });

  // 异步执行审核
  try {
    const report = await reviewService.runReview(
      req.file.path,
      req.file.mimetype,
      decodedName,
      (stepResult) => {
        const progress = reviewProgress.get(progressId);
        if (progress) {
          const existingIdx = progress.steps.findIndex(s => s.stepNumber === stepResult.stepNumber);
          if (existingIdx >= 0) {
            progress.steps[existingIdx] = stepResult;
          } else {
            progress.steps.push(stepResult);
          }
        }
      }
    );

    const progress = reviewProgress.get(progressId);
    if (progress) {
      progress.status = 'completed';
      progress.reportId = report.id;
    }
  } catch (err: any) {
    console.error('[Review] 审核失败:', err.message);
    const progress = reviewProgress.get(progressId);
    if (progress) {
      progress.status = 'error';
      progress.error = err.message || '审核失败';
    }
  } finally {
    try {
      await fs.unlink(req.file!.path);
    } catch { /* ignore */ }
  }
});

/**
 * GET /api/review/progress/:progressId
 * 获取审核进度
 */
router.get('/progress/:progressId', (req: Request, res: Response) => {
  const progress = reviewProgress.get(req.params.progressId);
  if (!progress) {
    res.status(404).json({ error: '进度不存在' });
    return;
  }
  res.json(progress);
});

/**
 * GET /api/review/reports
 * 获取所有审核报告列表
 */
router.get('/reports', async (_req: Request, res: Response) => {
  try {
    const reports = await reviewService.getAllReports();
    res.json(reports.map(r => ({
      id: r.id,
      fileName: r.fileName,
      projectName: r.projectInfo.projectName,
      overallScore: r.overallScore,
      riskLevel: r.riskLevel,
      createdAt: r.createdAt,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/review/reports/:id
 * 获取单个审核报告详情
 */
router.get('/reports/:id', async (req: Request, res: Response) => {
  try {
    const report = await reviewService.getReport(req.params.id);
    if (!report) {
      res.status(404).json({ error: '报告不存在' });
      return;
    }
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/review/reports/:id
 */
router.delete('/reports/:id', async (req: Request, res: Response) => {
  try {
    await reviewService.deleteReport(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/review/reports/:id/findings/:findingId
 * 删除报告中的单条问题并重算分数
 */
router.delete('/reports/:id/findings/:findingId', async (req: Request, res: Response) => {
  try {
    const updated = await reviewService.deleteFinding(req.params.id, req.params.findingId);
    if (!updated) {
      res.status(404).json({ error: '报告或问题条目不存在' });
      return;
    }
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/review/chat
 * 专家对话
 */
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { reportId, message, history } = req.body as ChatRequest;
    const report = await reviewService.getReport(reportId);
    if (!report) {
      res.status(404).json({ error: '报告不存在' });
      return;
    }

    const reportContext = JSON.stringify({
      projectInfo: report.projectInfo,
      score: report.overallScore,
      riskLevel: report.riskLevel,
      findings: report.steps.flatMap(s => s.findings),
      assessment: report.comprehensiveAssessment,
    }, null, 2);

    // RAG：检索与用户问题最相关的方案原文片段
    let schemeContext = '';
    try {
      const schemeChunks = await vectorStore.searchSchemeChunks(message, reportId, 5);
      if (schemeChunks.length > 0) {
        schemeContext = schemeChunks
          .map((c, i) => `【方案原文 ${i + 1}】\n${c.content}`)
          .join('\n\n');
      }
    } catch (err: any) {
      console.error('[Chat] 方案原文检索失败（继续使用报告上下文）：', err.message);
    }

    const answer = await aiService.chat(message, reportContext, schemeContext, history);
    res.json({ answer });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
