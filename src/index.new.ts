/**
 * ReThinking Park Cloudflare Worker
 * AI图像分析服务
 */
import { Env } from './types/env';
import { APIResponse } from './types/api';
import { handleImageAnalysis } from './handlers/imageAnalysis';
import { handleHealthCheck } from './handlers/healthCheck';
import { handleCacheManagement } from './handlers/cacheManagement';
import { addCorsHeaders, handleOptions } from './utils/cors';
import { checkRateLimit, getClientIP, RATE_LIMIT_CONFIG } from './utils/rateLimit';

/**
 * Main worker handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Get client IP for rate limiting
    const clientIP = getClientIP(request);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }
    
    // Check rate limit for non-OPTIONS requests
    const rateLimitResult = await checkRateLimit(clientIP, env);
    if (!rateLimitResult.allowed) {
      const response = Response.json({
        success: false,
        error: 'Rate limit exceeded. Try again later.',
        timestamp: new Date().toISOString(),
        retry_after: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
      } as APIResponse, { 
        status: 429,
        headers: {
          'Retry-After': Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000).toString(),
          'X-RateLimit-Limit': RATE_LIMIT_CONFIG.requests.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': Math.ceil(rateLimitResult.resetTime / 1000).toString()
        }
      });
      return addCorsHeaders(response, request);
    }

    let response: Response;

    switch (url.pathname) {
      case '/api/v1/health':
        response = await handleHealthCheck(env);
        break;
        
      case '/api/v1/cache':
        if (request.method !== 'GET') {
          response = Response.json({
            success: false,
            error: 'Method not allowed. Use GET with query parameters.',
            timestamp: new Date().toISOString()
          } as APIResponse, { status: 405 });
        } else {
          response = await handleCacheManagement(request, env);
        }
        break;
      
      case '/api/v1/analyze':
        if (request.method !== 'POST') {
          response = Response.json({
            success: false,
            error: 'Method not allowed',
            timestamp: new Date().toISOString()
          } as APIResponse, { status: 405 });
        } else {
          response = await handleImageAnalysis(request, env);
        }
        break;
      
      default:
        response = Response.json({
          success: false,
          error: 'Not Found',
          timestamp: new Date().toISOString()
        } as APIResponse, { status: 404 });
    }

    // Add rate limit headers to successful responses
    response.headers.set('X-RateLimit-Limit', RATE_LIMIT_CONFIG.requests.toString());
    response.headers.set('X-RateLimit-Remaining', rateLimitResult.remaining.toString());
    response.headers.set('X-RateLimit-Reset', Math.ceil(rateLimitResult.resetTime / 1000).toString());
    
    return addCorsHeaders(response, request);
  },
};
