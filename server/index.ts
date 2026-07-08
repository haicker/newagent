import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import reviewRouter from './routes/review.js';
import regulationsRouter from './routes/regulations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// API 路由
app.use('/api/review', reviewRouter);
app.use('/api/regulations', regulationsRouter);

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 生产环境静态文件服务
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (!config.llm.apiKey) {
    console.warn('警告: LLM_API_KEY 未设置，请在 .env 文件中配置');
  }
  if (!config.embedding.apiKey) {
    console.warn('警告: EMBEDDING_API_KEY 未设置，请在 .env 文件中配置');
  }
});
