import { useAppStore } from './store';

/**
 * 封装 fetch，自动携带 JWT Token
 * 收到 401 时自动清除登录状态
 */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = useAppStore.getState().token;
  const headers: Record<string, string> = { ...options.headers as Record<string, string> };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    useAppStore.getState().logout();
  }
  return res;
}
