import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import { config } from '../config.js';
import { RegulationService } from '../services/regulationService.js';
import { decodeFileName } from '../utils/fileName.js';

const router = Router();
const regulationService = new RegulationService();

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.mkdir(config.paths.uploads, { recursive: true });
    cb(null, config.paths.uploads);
  },
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${decodeFileName(file.originalname)}`);
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
 * GET /api/regulations
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const regulations = await regulationService.getAllRegulations();
    res.json(regulations);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/regulations/upload
 */
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: '请上传文件' });
    return;
  }
  try {
    const { name, code, category, province } = req.body;
    const regulation = await regulationService.parseRegulation(
      req.file.path,
      req.file.mimetype,
      name,
      code,
      category,
      province
    );
    res.json(regulation);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    if (req.file) {
      try { await fs.unlink(req.file.path); } catch { /* ignore */ }
    }
  }
});

/**
 * GET /api/regulations/search?keyword=xxx&limit=5&category=national&province=xxx&mandatory=true
 * LLM 增强搜索：向量检索 + LLM 提取有效信息
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const keyword = req.query.keyword as string;
    if (!keyword) {
      res.status(400).json({ error: '请提供搜索关键词' });
      return;
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string) : 5;
    const category = req.query.category as string | undefined;
    const province = req.query.province as string | undefined;
    const isMandatory = req.query.mandatory !== undefined
      ? req.query.mandatory === 'true'
      : undefined;

    const results = await regulationService.searchWithLLM(keyword, {
      limit,
      category,
      province,
      isMandatory,
    });

    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/regulations/stats
 * 获取向量库统计信息
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await regulationService.getVectorStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/regulations/:id
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await regulationService.deleteRegulation(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
