import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import { config } from '../config.js';
import { ReviewService } from '../services/reviewService.js';
import { AIService } from '../services/aiService.js';
import { PdfService } from '../services/pdfService.js';
import { vectorStore } from '../services/vectorStore.js';
import { decodeFileName } from '../utils/fileName.js';
import type { ChatRequest, ChatMessage, StepResult } from '../../shared/types.js';
import type { ReviewController } from '../services/reviewService.js';

const router = Router();
const reviewService = new ReviewService();
const aiService = new AIService();
const pdfService = new PdfService();

// 存储审核进度（内存中）
interface ReviewProgress {
  reportId?: string;
  steps: StepResult[];
  status: 'running' | 'paused' | 'completed' | 'error';
  error?: string;
  fileName: string;
  createdAt: number;
  finishedAt?: number;
}
const reviewProgress = new Map<string, ReviewProgress>();

// ── 审核控制器实现 ──
/**
 * 管理单个审核任务的控制信号（暂停/继续/跳过/重试/取消）
 * 服务层通过此对象检查控制状态，路由层通过此对象下发控制指令
 */
class ReviewControllerImpl implements ReviewController {
  private paused = false;
  private skipRequested = false;
  private retryRequested = false;
  aborted = false;
  private resumeResolver: (() => void) | null = null;

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    if (this.resumeResolver) {
      const resolver = this.resumeResolver;
      this.resumeResolver = null;
      resolver();
    }
  }

  requestSkip(): void {
    this.skipRequested = true;
    this.resume(); // 如果因错误暂停，同时解除阻塞
  }

  requestRetry(): void {
    this.retryRequested = true;
    this.resume(); // 如果因错误暂停，同时解除阻塞
  }

  abort(): void {
    this.aborted = true;
    this.resume(); // 解除暂停阻塞
  }

  async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>(resolve => {
      this.resumeResolver = resolve;
    });
  }

  consumeSkip(): boolean {
    const val = this.skipRequested;
    this.skipRequested = false;
    return val;
  }

  consumeRetry(): boolean {
    const val = this.retryRequested;
    this.retryRequested = false;
    return val;
  }
}

// 控制器存储：progressId → controller
const reviewControllers = new Map<string, ReviewControllerImpl>();

// SSE 订阅者管理：progressId → 回调集合
const progressSubscribers = new Map<string, Set<(progress: ReviewProgress) => void>>();

/** 向所有订阅者推送当前进度快照 */
function emitProgress(progressId: string): void {
  const progress = reviewProgress.get(progressId);
  if (!progress) return;
  const subs = progressSubscribers.get(progressId);
  if (subs) {
    for (const cb of subs) cb(progress);
  }
}

/** 订阅指定 progressId 的进度更新，返回取消订阅函数 */
function subscribeProgress(progressId: string, cb: (progress: ReviewProgress) => void): () => void {
  if (!progressSubscribers.has(progressId)) {
    progressSubscribers.set(progressId, new Set());
  }
  progressSubscribers.get(progressId)!.add(cb);
  return () => {
    progressSubscribers.get(progressId)?.delete(cb);
  };
}

// 定期清理已完成的审核进度（30 分钟后自动删除，防止内存泄漏）
const PROGRESS_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, progress] of reviewProgress) {
    if (progress.finishedAt && now - progress.finishedAt > PROGRESS_TTL_MS) {
      reviewProgress.delete(id);
      progressSubscribers.delete(id);
      reviewControllers.delete(id);
    }
  }
}, 5 * 60 * 1000); // 每 5 分钟清理一次

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
    createdAt: Date.now(),
  });

  // 立即返回 progressId，前端通过 SSE 接收进度
  const controller = new ReviewControllerImpl();
  reviewControllers.set(progressId, controller);

  res.json({ progressId, fileName: decodedName });

  // 异步执行审核
  try {
    const onStatusChange = (status: 'running' | 'paused') => {
      const p = reviewProgress.get(progressId);
      if (p) {
        p.status = status;
        emitProgress(progressId);
      }
    };

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
        emitProgress(progressId);
      },
      onStatusChange,
      controller,
    );

    const progress = reviewProgress.get(progressId);
    if (progress) {
      progress.status = 'completed';
      progress.reportId = report.id;
      progress.finishedAt = Date.now();
      emitProgress(progressId);
    }
  } catch (err: any) {
    console.error('[Review] 审核失败:', err.message);
    const progress = reviewProgress.get(progressId);
    if (progress) {
      progress.status = 'error';
      progress.error = err.message || '审核失败';
      progress.finishedAt = Date.now();
      emitProgress(progressId);
    }
  } finally {
    try {
      await fs.unlink(req.file!.path);
    } catch { /* ignore */ }
  }
});

/**
 * GET /api/review/progress/:progressId
 * 获取审核进度（单次查询，兼容旧接口）
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
 * GET /api/review/progress/:progressId/stream
 * SSE 推送审核进度（替代轮询）
 */
router.get('/progress/:progressId/stream', (req: Request, res: Response) => {
  const progressId = req.params.progressId;
  const progress = reviewProgress.get(progressId);
  if (!progress) {
    res.status(404).json({ error: '进度不存在' });
    return;
  }

  // SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',      // 禁用 Nginx 代理缓冲
    'Access-Control-Allow-Origin': '*', // 兼容跨域代理
  });

  // 禁用 Node.js HTTP server 的 socket 超时（默认 120s 会杀掉空闲连接）
  req.socket.setTimeout(0);
  req.socket.setKeepAlive(true);
  req.socket.setNoDelay(true);

  // 辅助函数：安全写入 SSE 数据
  const writeSSE = (data: ReviewProgress): boolean => {
    if (res.writableEnded) return false;
    try {
      return res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      return false;
    }
  };

  // 1. 立即推送当前快照（处理延迟连接，客户端可看到已完成步骤）
  writeSSE(progress);

  // 2. 若已结束，关闭连接
  if (progress.status === 'completed' || progress.status === 'error') {
    res.end();
    return;
  }

  // 3. 订阅后续更新
  const unsubscribe = subscribeProgress(progressId, (updated) => {
    writeSSE(updated);
    if (updated.status === 'completed' || updated.status === 'error') {
      res.end();
    }
  });

  // 4. 心跳保活（每 15 秒发一条 SSE 注释，短于大多数代理超时阈值）
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      try { res.write(': heartbeat\n\n'); } catch { /* ignore */ }
    }
  }, 15_000);

  // 5. 客户端断开时清理
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ── 审核控制端点 ──

/**
 * POST /api/review/progress/:progressId/pause
 * 暂停审核（在当前步骤完成后生效）
 */
router.post('/progress/:progressId/pause', (req: Request, res: Response) => {
  const controller = reviewControllers.get(req.params.progressId);
  const progress = reviewProgress.get(req.params.progressId);
  if (!controller || !progress) {
    res.status(404).json({ error: '审核进度不存在' });
    return;
  }
  if (progress.status !== 'running') {
    res.status(400).json({ error: '审核不在运行中，无法暂停' });
    return;
  }
  controller.pause();
  progress.status = 'paused';
  emitProgress(req.params.progressId);
  res.json({ success: true });
});

/**
 * POST /api/review/progress/:progressId/resume
 * 继续审核（解除暂停）
 */
router.post('/progress/:progressId/resume', (req: Request, res: Response) => {
  const controller = reviewControllers.get(req.params.progressId);
  const progress = reviewProgress.get(req.params.progressId);
  if (!controller || !progress) {
    res.status(404).json({ error: '审核进度不存在' });
    return;
  }
  if (progress.status !== 'paused') {
    res.status(400).json({ error: '审核未暂停，无需继续' });
    return;
  }
  controller.resume();
  progress.status = 'running';
  emitProgress(req.params.progressId);
  res.json({ success: true });
});

/**
 * POST /api/review/progress/:progressId/skip
 * 跳过当前步骤（如果步骤正在执行，完成后丢弃结果；如果在步骤间，跳过下一步）
 */
router.post('/progress/:progressId/skip', (req: Request, res: Response) => {
  const controller = reviewControllers.get(req.params.progressId);
  const progress = reviewProgress.get(req.params.progressId);
  if (!controller || !progress) {
    res.status(404).json({ error: '审核进度不存在' });
    return;
  }
  if (progress.status === 'completed' || progress.status === 'error') {
    res.status(400).json({ error: '审核已结束，无法跳过' });
    return;
  }
  controller.requestSkip();
  // 如果因错误暂停，requestSkip 已解除阻塞；如果用户主动暂停，也解除
  if (progress.status === 'paused') {
    progress.status = 'running';
    emitProgress(req.params.progressId);
  }
  res.json({ success: true });
});

/**
 * POST /api/review/progress/:progressId/retry
 * 重试失败的步骤（解除错误暂停，重新执行失败的步骤）
 */
router.post('/progress/:progressId/retry', (req: Request, res: Response) => {
  const controller = reviewControllers.get(req.params.progressId);
  const progress = reviewProgress.get(req.params.progressId);
  if (!controller || !progress) {
    res.status(404).json({ error: '审核进度不存在' });
    return;
  }
  if (progress.status !== 'paused') {
    res.status(400).json({ error: '审核未暂停，无法重试' });
    return;
  }
  controller.requestRetry();
  progress.status = 'running';
  emitProgress(req.params.progressId);
  res.json({ success: true });
});

/**
 * POST /api/review/progress/:progressId/abort
 * 取消审核
 */
router.post('/progress/:progressId/abort', (req: Request, res: Response) => {
  const controller = reviewControllers.get(req.params.progressId);
  const progress = reviewProgress.get(req.params.progressId);
  if (!controller || !progress) {
    res.status(404).json({ error: '审核进度不存在' });
    return;
  }
  controller.abort();
  if (progress.status !== 'completed' && progress.status !== 'error') {
    progress.status = 'error';
    progress.error = '用户取消审核';
    progress.finishedAt = Date.now();
    emitProgress(req.params.progressId);
  }
  res.json({ success: true });
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
 * GET /api/review/reports/:id/pdf
 * 导出报告为 PDF
 */
router.get('/reports/:id/pdf', async (req: Request, res: Response) => {
  try {
    const report = await reviewService.getReport(req.params.id);
    if (!report) {
      res.status(404).json({ error: '报告不存在' });
      return;
    }
    const pdfBuffer = await pdfService.generatePdf(report);
    const fileName = encodeURIComponent(`${report.projectInfo.projectName}_审核报告.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
    res.send(pdfBuffer);
  } catch (err: any) {
    console.error('[Review] PDF 导出失败:', err.message);
    res.status(500).json({ error: 'PDF 导出失败: ' + err.message });
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
 * GET /api/review/reports/:id/messages
 * 获取报告关联的对话消息
 */
router.get('/reports/:id/messages', async (req: Request, res: Response) => {
  try {
    const messages = await reviewService.getChatMessages(req.params.id);
    res.json(messages);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/review/chat
 * 专家对话（消息持久化到后端）
 */
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { reportId, message } = req.body as ChatRequest;
    const report = await reviewService.getReport(reportId);
    if (!report) {
      res.status(404).json({ error: '报告不存在' });
      return;
    }

    // 从后端加载已持久化的对话历史（作为唯一来源）
    const history = await reviewService.getChatMessages(reportId);

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

    // RAG：检索与用户问题最相关的法规条款（含强条优先检索）
    let regulationContext = '';
    try {
      // 先检索强条（确保合规性问题命中强制性条文）
      const mandatoryHits = await vectorStore.search(message, { limit: 3, isMandatory: true });
      // 再检索全量条款（不限是否强条）
      const generalHits = await vectorStore.search(message, { limit: 5 });
      // 合并去重（按 id）
      const seenIds = new Set<string>();
      const merged = [...mandatoryHits, ...generalHits].filter(r => {
        if (seenIds.has(r.id)) return false;
        seenIds.add(r.id);
        return true;
      });
      if (merged.length > 0) {
        regulationContext = merged
          .map((r, i) => {
            const mandatoryTag = r.isMandatory ? '【强条】' : '';
            return `【法规条款 ${i + 1}】${mandatoryTag}来源：${r.regulation}，${r.section}\n${r.content}`;
          })
          .join('\n\n');
      }
    } catch (err: any) {
      console.error('[Chat] 法规条款检索失败（继续使用报告上下文）：', err.message);
    }

    const answer = await aiService.chat(message, reportContext, schemeContext, regulationContext, history);

    // 持久化用户消息和专家回复
    const now = new Date().toISOString();
    const updatedMessages: ChatMessage[] = [
      ...history,
      { role: 'user', content: message, timestamp: now },
      { role: 'assistant', content: answer, timestamp: now },
    ];
    await reviewService.saveChatMessages(reportId, updatedMessages);

    res.json({ answer });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
