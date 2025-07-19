/**
 * 速率限制工具
 * 提供API请求的速率限制和IP检测功能
 */
import { Env } from '../types/env';

/**
 * 速率限制配置
 */
export const RATE_LIMIT_CONFIG = {
  requests: 100, // 每个时间窗口内允许的请求数
  window: 3600,  // 时间窗口大小（秒，当前设置为1小时）
  blockDuration: 1800 // 超出限制后的封禁时长（秒，当前设置为30分钟）
};

/**
 * 获取客户端IP地址
 * 尝试从各种请求头中提取客户端的真实IP地址
 * 
 * @param request - 接收到的HTTP请求对象
 * @returns 客户端IP地址字符串，如果无法确定则返回'unknown'
 */
export function getClientIP(request: Request): string {
  // Try CF-Connecting-IP first (Cloudflare's real IP header)
  const cfIP = request.headers.get('CF-Connecting-IP');
  if (cfIP) return cfIP;
  
  // Fallback to X-Forwarded-For
  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  
  // Last resort
  return 'unknown';
}

/**
 * 检查IP地址的速率限制
 * 实现基于KV存储的请求速率限制，防止API滥用
 * 
 * @param ip - 客户端IP地址
 * @param env - 环境变量和绑定资源
 * @returns 包含是否允许请求、剩余请求配额和重置时间的对象
 */
export async function checkRateLimit(ip: string, env: Env): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
  if (!env.RATE_LIMIT_KV) {
    // If KV is not available, allow all requests but log warning
    console.warn('Rate limiting KV not configured, allowing all requests');
    return { allowed: true, remaining: RATE_LIMIT_CONFIG.requests, resetTime: Date.now() + RATE_LIMIT_CONFIG.window * 1000 };
  }
  
  const now = Date.now();
  const windowStart = Math.floor(now / (RATE_LIMIT_CONFIG.window * 1000)) * (RATE_LIMIT_CONFIG.window * 1000);
  const key = `rate_limit:${ip}:${windowStart}`;
  const blockKey = `blocked:${ip}`;
  
  // Check if IP is currently blocked
  try {
    const blocked = await env.RATE_LIMIT_KV.get(blockKey);
    if (blocked) {
      const blockData = JSON.parse(blocked);
      if (now < blockData.unblockTime) {
        return {
          allowed: false,
          remaining: 0,
          resetTime: blockData.unblockTime
        };
      } else {
        // Block expired, remove it
        await env.RATE_LIMIT_KV.delete(blockKey);
      }
    }
  } catch (error) {
    console.error('Error checking block status:', error);
  }
  
  // Get current request count
  try {
    const current = await env.RATE_LIMIT_KV.get(key);
    const count = current ? parseInt(current) : 0;
    
    if (count >= RATE_LIMIT_CONFIG.requests) {
      // Rate limit exceeded, block the IP
      const blockData = {
        blockedAt: now,
        unblockTime: now + (RATE_LIMIT_CONFIG.blockDuration * 1000),
        reason: 'rate_limit_exceeded'
      };
      
      await env.RATE_LIMIT_KV.put(blockKey, JSON.stringify(blockData), {
        expirationTtl: RATE_LIMIT_CONFIG.blockDuration
      });
      
      console.warn(`IP ${ip} blocked for ${RATE_LIMIT_CONFIG.blockDuration}s due to rate limit`);
      
      return {
        allowed: false,
        remaining: 0,
        resetTime: blockData.unblockTime
      };
    }
    
    // Increment counter
    await env.RATE_LIMIT_KV.put(key, (count + 1).toString(), {
      expirationTtl: RATE_LIMIT_CONFIG.window
    });
    
    return {
      allowed: true,
      remaining: RATE_LIMIT_CONFIG.requests - count - 1,
      resetTime: windowStart + (RATE_LIMIT_CONFIG.window * 1000)
    };
    
  } catch (error) {
    console.error('Rate limit check failed:', error);
    // On error, allow the request but log the issue
    return { allowed: true, remaining: RATE_LIMIT_CONFIG.requests, resetTime: now + RATE_LIMIT_CONFIG.window * 1000 };
  }
}
