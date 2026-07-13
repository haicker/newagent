import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import authRouter from './routes/auth.js';
import { authRequired } from './middleware/auth.js';
import reviewRouter from './routes/review.js';
import regulationsRouter from './routes/regulations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// API 路由
// 认证路由（无需鉴权）
app.use('/api/auth', authRouter);
// 以下路由需要登录
app.use('/api/review', authRequired, reviewRouter);
app.use('/api/regulations', authRequired, regulationsRouter);

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

const server = app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (!config.llm.apiKey) {
    console.warn('警告: LLM_API_KEY 未设置，请在 .env 文件中配置');
  }
  if (!config.embedding.apiKey) {
    console.warn('警告: EMBEDDING_API_KEY 未设置，请在 .env 文件中配置');
  }
});

// 禁用 HTTP server 超时，防止长连接 SSE 被杀
server.timeout = 0;           // 禁用请求超时（默认 120s 会断 SSE）
server.keepAliveTimeout = 0;  // 禁用 keep-alive 超时
server.headersTimeout = 0;    // 禁用请求头超时
