/**
 * 缓存管理处理程序
 * 提供API端点用于查看和管理缓存
 */
import { CacheService } from '../services/cache';
import { Env } from '../types/env';

/**
 * 处理缓存管理请求
 * 提供API端点用于查看、清除缓存信息
 * 仅供开发和管理目的使用
 * 
 * @param request - HTTP请求对象
 * @param env - 环境变量和绑定资源
 * @returns HTTP响应对象
 */
export async function handleCacheManagement(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const action = url.searchParams.get('action');
	
	if (!env.IMAGE_CACHE_KV) {
		return Response.json({
			success: false,
			error: 'KV 缓存未配置',
			timestamp: new Date().toISOString()
		}, { status: 500 });
	}

	switch (action) {
		case 'clear':
			// 获取当前缓存统计信息
			const stats = await CacheService.getStats(env);
			const oldSize = stats.size;
			
			// 清除缓存
			await CacheService.clear(env);
			console.log(`Cache cleared. Removed ${oldSize} entries.`);
			
			return Response.json({
				success: true,
				message: `Cache cleared. Removed ${oldSize} entries.`,
				timestamp: new Date().toISOString()
			});
			
		case 'size':
			// 获取缓存统计信息
			const cacheStats = await CacheService.getStats(env);
			const entries = [];
			
			// 收集缓存条目详情
			if (cacheStats.keys.length > 0) {
				// 限制显示的缓存条目数量
				const displayKeys = cacheStats.keys.slice(0, 20); // 最多显示20条
				
				for (const key of displayKeys) {
					const entry = await CacheService.get(env, key);
					if (entry) {
						entries.push({
							hash: key.substring(0, 16) + '...',
							timestamp: entry.timestamp,
							elements_count: entry.elements?.length || 0,
							processing_time: entry.processingTime
						});
					}
				}
			}
			
			return Response.json({
				cache_size: cacheStats.size,
				entries,
				timestamp: new Date().toISOString(),
				cache_provider: 'Cloudflare KV'
			});
			
		case 'delete':
			const hashToDelete = url.searchParams.get('hash');
			if (!hashToDelete) {
				return Response.json({
					success: false,
					error: 'Hash parameter required for delete action',
					timestamp: new Date().toISOString()
				}, { status: 400 });
			}
			
			// 获取所有缓存键
			const cacheKeys = (await CacheService.getStats(env)).keys;
			
			// 查找以提供的前缀开头的完整哈希
			const fullHash = cacheKeys.find(key => key.startsWith(hashToDelete));
			
			if (fullHash) {
				// 删除缓存条目
				const deleted = await CacheService.delete(env, fullHash);
				
				if (deleted) {
					console.log(`Cache entry deleted: ${fullHash.substring(0, 16)}...`);
					return Response.json({
						success: true,
						message: `Cache entry deleted: ${fullHash.substring(0, 16)}...`,
						timestamp: new Date().toISOString()
					});
				}
			}
			
			return Response.json({
				success: false,
				error: 'Cache entry not found or delete operation failed',
				timestamp: new Date().toISOString()
			}, { status: 404 });
			
		default:
			return Response.json({
				success: false,
				error: 'Invalid action. Use: clear, size, or delete',
				available_actions: [
					'?action=clear - Clear all cache entries',
					'?action=size - Show cache size and entries',
					'?action=delete&hash=<hash_prefix> - Delete specific entry'
				],
				timestamp: new Date().toISOString()
			}, { status: 400 });
	}
}
