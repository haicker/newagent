import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// 扩展 Express Request 类型，挂载用户信息
declare global {
  namespace Express {
    interface Request {
      user?: { username: string; name: string };
    }
  }
}

/**
 * JWT 认证中间件
 * 校验 Authorization: Bearer <token> 头，通过后挂载 req.user
 */
export function authRequired(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret) as { username: string; name: string };
    req.user = { username: decoded.username, name: decoded.name };
    next();
  } catch {
    return res.status(401).json({ error: 'Token 无效或已过期，请重新登录' });
  }
}
