import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { LoginRequest, LoginResponse } from '../../shared/types.js';

const router = Router();

/**
 * POST /api/auth/login
 * 验证用户名密码，返回 JWT Token
 */
router.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body as LoginRequest;

  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  if (username !== config.auth.username || password !== config.auth.password) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const user = { username, name: username };
  const token = jwt.sign(user, config.auth.jwtSecret, {
    expiresIn: config.auth.tokenExpiry as jwt.SignOptions['expiresIn'],
  });

  const response: LoginResponse = { token, user };
  res.json(response);
});

/**
 * GET /api/auth/me
 * 获取当前登录用户信息（需携带 Token）
 */
router.get('/me', (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: '未登录' });
  }
  res.json({ user: req.user });
});

export default router;
