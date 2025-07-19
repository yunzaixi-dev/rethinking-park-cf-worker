/**
 * 健康检查处理程序
 * 提供服务状态和配置信息的接口
 */
import { Env } from '../types/env';
import { CacheService } from '../services/cache';

/**
 * 处理健康检查请求
 * 返回后端服务状态、版本信息和配置概况
 * 用于监控和调试目的
 * 
 * @param env - 环境变量和绑定资源
 * @returns 包含服务状态信息的HTTP响应
 */
export async function handleHealthCheck(env: Env): Promise<Response> {
	const cacheEnabled = env.CACHE_ENABLED !== 'false';
	const cacheTtl = parseInt(env.CACHE_TTL) || 3600;
	
	// 获取缓存统计信息
	let cacheStats: { size: number; keys: string[] } = { size: 0, keys: [] };
	let cacheEntries = [];
	
	if (cacheEnabled && env.IMAGE_CACHE_KV) {
		cacheStats = await CacheService.getStats(env);
		
		// 准备缓存条目信息
		if (cacheStats.keys.length > 0) {
			// 限制显示的缓存条目数量以避免响应过大
			const displayKeys = cacheStats.keys.slice(0, 10);
			
			for (const key of displayKeys) {
				const entry = await CacheService.get(env, key);
				if (entry) {
					cacheEntries.push({
						hash: key.substring(0, 16) + '...',
						timestamp: entry.timestamp
					});
				}
			}
		}
	}
	
	return Response.json({
		status: 'healthy',
		timestamp: new Date().toISOString(),
		cache_enabled: cacheEnabled,
		cache_size: cacheStats.size,
		cache_ttl: cacheTtl,
		cache_entries: cacheEntries,
		service: 'ReThinking Park Cloudflare Worker',
		cache_provider: env.IMAGE_CACHE_KV ? 'Cloudflare KV' : 'Not configured'
	});
}
