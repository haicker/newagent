# 深基坑支护方案审核系统

AI 驱动的深基坑支护及土方开挖专项施工方案合规性审查系统。上传施工方案与法规标准，系统通过多步流水线自动完成完整性、合规性、支护专项与地方法规审查，并生成评分报告与可对话的专家助手。

## 功能特性

- **方案上传与解析**：支持 PDF / DOCX，自动提取文本并清洗（基于 `pdf-parse`、`pdfjs-dist`、`mammoth`）
- **法规库管理**：上传国家 / 行业 / 地方标准，自动解析为结构化条款（含强条识别），并写入向量库供检索
- **AI 多维度审查**：6 步流水线（信息提取 → 完整性 → 合规性 → 支护专项 → 地方法规 → 汇总报告）
- **评分与分级**：0–100 综合评分 + 风险等级（low / medium / high / critical）+ 分级 findings（critical / major / minor / info）
- **确定性评分引擎**：评分由确定性公式计算（每条 finding 按严重度绑定可配置扣分权重），AI 只给建议分与理由；首次评分与删除 finding 重算使用同一公式，分数可复现、可解释；报告记录扣分明细
- **专家对话**：基于审核报告的 RAG 问答，检索方案原文片段与报告上下文，支持多轮对话
- **向量检索**：基于 LanceDB 的法规条款与方案原文向量库，支持 LLM 增强搜索

## 技术栈

**后端**

- Node.js + Express + TypeScript（`tsx` 开发热更新，`tsc` 生产构建）
- OpenAI 兼容 API（对话 / 审核使用 `LLM_*` 配置，向量化使用 `EMBEDDING_*` 配置）
- LanceDB 向量数据库（法规条款 + 方案原文）
- `mammoth`（DOCX）、`pdf-parse` / `pdfjs-dist`（PDF）、`multer`（上传）

**前端**

- React 18 + TypeScript + Vite
- Zustand（状态管理）
- `react-markdown` + `remark-gfm`（报告 / 对话渲染）
- 原生 CSS

## 快速开始

### 1. 环境要求

- Node.js 18+
- npm

### 2. 安装依赖

```bash
npm run install:all
```

### 3. 配置环境变量

复制 `.env.example` 为 `.env` 并填入配置：

```bash
cp .env.example .env
```

`.env` 关键配置（注意：本系统使用 `LLM_*` / `EMBEDDING_*` 前缀，而非 `OPENAI_*`）：

```env
# 语言模型配置（对话 / 审核）
LLM_API_KEY=your_llm_api_key_here
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4-turbo-preview

# 向量化模型配置（Embedding）
EMBEDDING_API_KEY=your_embedding_api_key_here
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536

# 服务器与上传
PORT=3000
MAX_FILE_SIZE=10485760
```

> 使用国产模型（通义千问、Kimi、智谱等）时，将 `LLM_BASE_URL` / `EMBEDDING_BASE_URL` 与对应 `MODEL` 改为厂商提供的 OpenAI 兼容端点即可。

### 4. 启动开发服务器

```bash
npm run dev
```

同时启动：

- 后端服务：`http://localhost:3000`
- 前端开发服务器：`http://localhost:5173`

### 5. 生产环境构建与运行

```bash
npm run build
npm start
```

生产模式下后端会托管 `client/dist` 静态文件，访问 `http://localhost:3000` 即可。

## 项目结构

```
.
├── server/                 # 后端（Express + TS）
│   ├── index.ts            # 服务入口，挂载路由 + 静态托管
│   ├── config.ts           # 读取 .env 配置
│   ├── routes/
│   │   ├── review.ts       # 方案审核 / 报告 / 专家对话 路由
│   │   └── regulations.ts  # 法规库上传 / 搜索 / 统计 路由
│   ├── services/
│   │   ├── aiService.ts        # AI 审查与对话调用
│   │   ├── reviewService.ts    # 6 步审核流水线编排
│   │   ├── regulationService.ts# 法规解析与向量化检索
│   │   └── vectorStore.ts      # LanceDB 向量库封装
│   └── utils/
│       └── fileParser.ts   # PDF / DOCX 文本解析与清洗
├── client/                 # 前端（React + Vite）
│   └── src/
│       ├── App.tsx / main.tsx
│       ├── store.ts        # Zustand 全局状态
│       ├── types.ts        # 前端类型
│       └── pages/          # ReviewPage / ReportsPage / RegulationsPage
├── shared/                 # 前后端共享类型
│   └── types.ts
├── data/                   # 本地数据存储（运行时生成）
│   ├── regulations/        # 法规库文件
│   ├── reports/            # 审核报告（JSON）
│   └── vector_db/          # LanceDB 向量库
└── uploads/                # 临时上传目录
```

## 使用说明

1. 进入「法规库」页面，上传 JGJ 120-2012、GB 50497-2019、JGJ 311-2013 等国家 / 行业标准文件
2. 上传地方标准文件时，选择「地方标准」并填写适用省份
3. 进入「方案审核」页面，上传 PDF 或 DOCX 格式的施工方案，系统异步执行 6 步流水线并实时展示进度
4. 在「历史报告」中查看评分、风险等级、分级 findings 与综合评估，可删除单条问题触发分数重算，支持一键导出 PDF 报告
5. 使用「专家对话」功能，基于报告上下文与方案原文进行问答

## 审核流水线

| 步骤 | 名称 | 说明 |
|------|------|------|
| Step 0 | 提取基本信息 | 从文档解析工程名称、省份、城市、支护形式、开挖深度等 |
| Step 1 | 完整性检查 | 检查方案缺项、规范引用、危险源、计算书等 |
| Step 2 | 合规性检查 | 核对法规库中的强条（强制条文） |
| Step 3 | 支护专项检查 | 按支护类型（桩锚、地下连续墙、土钉墙等）专项审查 |
| Step 4 | 地方法规审查 | 按项目省份检索地方法规与地方特殊要求 |
| Step 5 | 汇总报告 | 合并 findings，计算评分与风险等级，生成综合评估 |

## API 概览

基础路径 `http://localhost:3000/api`

**审核 `/review`**

- `POST /review/upload` — 上传方案文件，返回 `progressId`（异步，通过 SSE 推送进度）
- `GET /review/progress/:progressId/stream` — SSE 实时推送审核进度
- `GET /review/progress/:progressId` — 获取审核进度（单次查询，轮询降级兜底）
- `GET /review/reports` — 报告列表
- `GET /review/reports/:id` — 报告详情
- `DELETE /review/reports/:id` — 删除报告
- `DELETE /review/reports/:id/findings/:findingId` — 删除单条问题并重算分数
- `GET /review/reports/:id/pdf` — 导出报告为 PDF
- `POST /review/chat` — 专家对话（RAG）

**法规库 `/regulations`**

- `GET /regulations` — 法规列表
- `POST /regulations/upload` — 上传并解析法规（写入向量库）
- `GET /regulations/search?keyword=&limit=&category=&province=&mandatory=` — LLM 增强搜索
- `GET /regulations/stats` — 向量库统计
- `DELETE /regulations/:id` — 删除法规

## 注意事项

- 首次使用前必须配置 `LLM_API_KEY` 与 `EMBEDDING_API_KEY`，否则审查与向量检索不可用
- 法规库建议至少包含 JGJ 120-2012、GB 50497-2019 等常用规范，合规性与地方法规审查才有效
- 本系统基于 AI 模型辅助审查，结果仅供参考，须由专业人员复核确认
- 所有数据默认以 JSON / 向量库形式存储在 `data/` 目录，无需外部数据库

## 生产部署（Linux + Nginx）

### Nginx 反向代理配置

SSE 长连接需要特殊配置，否则 Nginx 会缓冲或超时断开连接，导致前端报 `Failed to fetch`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 前端静态文件（可选，也可由后端托管）
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # API 接口
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ── SSE 专用配置 ──
        proxy_buffering off;           # 关闭响应缓冲（SSE 必须）
        proxy_cache off;               # 关闭缓存
        proxy_read_timeout 3600s;      # 读取超时设为 1 小时（覆盖默认 60s）
        proxy_send_timeout 3600s;      # 发送超时同步加大
        chunked_transfer_encoding on;  # 启用分块传输
    }
}
```

> **关键项**：`proxy_buffering off` 防止 Nginx 缓存 SSE 数据；`proxy_read_timeout 3600s` 防止空闲断连。

### 前端 SSE 稳定性机制

前端已内置三级容错策略：

1. **SSE 实时推送**（首选）— 连接 `/api/review/progress/:id/stream`，步骤变更即时到达
2. **自动重连** — SSE 断线后指数退避重试（最多 3 次，间隔 2s/4s/6s），UI 显示"正在重连..."
3. **降级轮询** — 重连耗尽后自动切换到 `GET /progress/:id` 轮询（间隔 2s），UI 显示"已切换到轮询模式"

### 使用 PM2 进程管理

```bash
npm install -g pm2
npm run build
pm2 start dist/server/index.js --name pit-review
pm2 save
pm2 startup  # 开机自启
```
