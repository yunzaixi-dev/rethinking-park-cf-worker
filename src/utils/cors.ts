/**
 * CORS处理工具
 * 实现跨域资源共享相关功能
 */

/**
 * 检查请求源是否在允许列表中
 * 
 * @param origin - 请求源URL
 * @returns 是否允许该来源
 */
export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  
  // 定义允许的来源列表
  const allowedOrigins = [
    'http://localhost',
    'https://localhost',
    'http://127.0.0.1',
    'https://rethinkingpark.com',
    'https://dev.rethinkingpark.com',
    'https://staging.rethinkingpark.com',
  ];
  
  return allowedOrigins.some(allowedOrigin => origin.startsWith(allowedOrigin));
}

/**
 * 处理OPTIONS请求
 * 实现CORS预检请求（preflight）响应
 * 允许跨域资源请求所需的HTTP方法和头部
 * 
 * @param request - HTTP请求对象
 * @returns 适当的OPTIONS响应对象
 */
export function handleOptions(request: Request): Response {
  const origin = request.headers.get('Origin');
  const allowedOrigin = isOriginAllowed(origin) ? origin : null;
  
  if (!allowedOrigin) {
    return new Response('CORS: Origin not allowed', { status: 403 });
  }
  
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    },
  });
}

/**
 * 向响应添加CORS头部
 * 为所有API响应添加正确的跨域资源共享头部
 * 
 * @param response - 原始HTTP响应对象
 * @param request - 相关的HTTP请求对象
 * @returns 添加了CORS头部的新响应对象
 */
export function addCorsHeaders(response: Response, request: Request): Response {
  const origin = request.headers.get('Origin');
  const allowedOrigin = isOriginAllowed(origin) ? origin : null;
  
  const newResponse = new Response(response.body, response);
  
  if (allowedOrigin) {
    newResponse.headers.set('Access-Control-Allow-Origin', allowedOrigin);
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    newResponse.headers.set('Vary', 'Origin');
  }
  
  return newResponse;
}
