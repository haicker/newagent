import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 3000,

  // 语言模型配置（对话/审核）
  llm: {
    apiKey: process.env.LLM_API_KEY || '',
    baseURL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.LLM_MODEL || 'gpt-4-turbo-preview',
  },

  // 向量化模型配置（Embedding）
  embedding: {
    apiKey: process.env.EMBEDDING_API_KEY || '',
    baseURL: process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    dimension: parseInt(process.env.EMBEDDING_DIMENSION || '1536'),
  },

  upload: {
    allowedTypes: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },

  // 认证配置
  auth: {
    username: process.env.AUTH_USERNAME || 'admin',
    password: process.env.AUTH_PASSWORD || 'admin123',
    jwtSecret: process.env.JWT_SECRET || 'default-secret-change-me',
    tokenExpiry: '7d',
  },

  // 评分引擎配置（确定性扣分权重）
  scoring: {
    baseScore: 100,                                      // 基础分
    minScore: 0,                                         // 最低分
    weights: {
      critical: parseInt(process.env.SCORE_WEIGHT_CRITICAL || '15'),  // 每条严重问题扣分
      major: parseInt(process.env.SCORE_WEIGHT_MAJOR || '8'),        // 每条重要问题扣分
      minor: parseInt(process.env.SCORE_WEIGHT_MINOR || '3'),        // 每条一般问题扣分
      info: 0,                                           // 提示级不扣分
    },
    // 风险等级阈值（score < threshold → 该等级）
    riskThresholds: {
      critical: 40,  // score < 40 或有 critical → critical
      high: 60,      // score < 60 → high
      medium: 75,   // score < 75 → medium
      // score >= 75 → low
    },
  },

  paths: {
    uploads: './uploads',
    regulations: './data/regulations',
    reports: './data/reports',
    vectorDb: './data/vector_db',
  }
};
