/**
 * 缓存服务模块
 * 使用 Cloudflare KV 提供分析结果的持久化缓存功能
 */
import { Env } from '../types/env';
import { AnalysisResult } from '../types/api';

// 默认缓存前缀
// 用于区分不同类型的 KV 项目
// 可在将来扩展以支持不同类型的缓存
const CACHE_PREFIX = 'image-analysis:';

// 缓存名称与原始键之间的分隔符
const CACHE_DELIMITER = ':';

/**
 * 缓存服务类
 * 提供基于 Cloudflare KV 的缓存管理和操作方法
 */
export class CacheService {
  /**
   * 生成缓存键
   * @param key - 原始缓存键（通常是图像哈希）
   * @returns 格式化的缓存键
   */
  private static formatKey(key: string): string {
    return `${CACHE_PREFIX}${key}`;
  }

  /**
   * 从完整缓存键中提取原始键
   * @param fullKey - 完整缓存键
   * @returns 原始键（没有前缀）
   */
  private static extractOriginalKey(fullKey: string): string {
    if (fullKey.startsWith(CACHE_PREFIX)) {
      return fullKey.substring(CACHE_PREFIX.length);
    }
    return fullKey;
  }

  /**
   * 从 KV 中获取缓存项
   * @param env - 环境变量对象，包含 KV 绑定
   * @param key - 缓存键（通常是图像哈希）
   * @returns 缓存的分析结果或 undefined（如果不存在或已过期）
   */
  static async get(env: Env, key: string): Promise<AnalysisResult | undefined> {
    // 检查缓存是否启用
    if (env.CACHE_ENABLED === 'false' || !env.IMAGE_CACHE_KV) {
      return undefined;
    }

    try {
      const formattedKey = this.formatKey(key);
      const cachedData = await env.IMAGE_CACHE_KV.get(formattedKey, { type: 'json' });
      
      if (cachedData) {
        console.log(`缓存命中: ${key}`);
        return cachedData as AnalysisResult;
      }
    } catch (error) {
      console.error(`从 KV 缓存获取失败: ${key}`, error);
    }
    
    return undefined;
  }

  /**
   * 将分析结果存储到 KV 缓存中
   * @param env - 环境变量对象，包含 KV 绑定
   * @param key - 缓存键（通常是图像哈希）
   * @param value - 要缓存的分析结果
   * @returns 是否成功设置缓存
   */
  static async set(env: Env, key: string, value: AnalysisResult): Promise<boolean> {
    // 检查缓存是否启用
    if (env.CACHE_ENABLED === 'false' || !env.IMAGE_CACHE_KV) {
      return false;
    }

    try {
      const formattedKey = this.formatKey(key);
      const ttl = parseInt(env.CACHE_TTL || '3600'); // 默认 1 小时
      
      // 将对象存储为 JSON，并设置过期时间
      await env.IMAGE_CACHE_KV.put(formattedKey, JSON.stringify(value), { expirationTtl: ttl });
      console.log(`缓存已设置: ${key}, TTL: ${ttl} 秒`);
      return true;
    } catch (error) {
      console.error(`设置 KV 缓存失败: ${key}`, error);
      return false;
    }
  }

  /**
   * 删除缓存项
   * @param env - 环境变量对象，包含 KV 绑定
   * @param key - 要删除的缓存键
   * @returns 是否成功删除
   */
  static async delete(env: Env, key: string): Promise<boolean> {
    if (!env.IMAGE_CACHE_KV) {
      return false;
    }

    try {
      const formattedKey = this.formatKey(key);
      await env.IMAGE_CACHE_KV.delete(formattedKey);
      console.log(`缓存项已删除: ${key}`);
      return true;
    } catch (error) {
      console.error(`删除缓存项失败: ${key}`, error);
      return false;
    }
  }

  /**
   * 清除所有缓存
   * @param env - 环境变量对象，包含 KV 绑定
   * @returns 是否成功清除所有缓存
   */
  static async clear(env: Env): Promise<boolean> {
    if (!env.IMAGE_CACHE_KV) {
      return false;
    }

    try {
      // 获取所有带有特定前缀的键
      const keys = await this.listKeys(env);
      
      // 删除每一个键
      const deletePromises = keys.map(key => env.IMAGE_CACHE_KV.delete(key));
      await Promise.all(deletePromises);
      
      console.log(`清除了 ${keys.length} 个缓存项`);
      return true;
    } catch (error) {
      console.error('清除缓存失败:', error);
      return false;
    }
  }

  /**
   * 列出所有缓存键
   * @param env - 环境变量对象，包含 KV 绑定
   * @returns 所有缓存键的列表
   */
  static async listKeys(env: Env): Promise<string[]> {
    if (!env.IMAGE_CACHE_KV) {
      return [];
    }

    try {
      const keys: string[] = [];
      let cursor: string | undefined;
      
      // 分页获取所有键
      do {
        const result = await env.IMAGE_CACHE_KV.list({
          prefix: CACHE_PREFIX,
          cursor
        });
        
        // 添加当前页的键
        keys.push(...result.keys.map((k: { name: string }) => k.name));
        
        // 更新分页光标
        cursor = result.cursor;
      } while (cursor);
      
      return keys;
    } catch (error) {
      console.error('列出缓存键失败:', error);
      return [];
    }
  }

  /**
   * 获取缓存统计信息
   * @param env - 环境变量对象，包含 KV 绑定
   * @returns 缓存统计信息，包括缓存项数量和键列表
   */
  static async getStats(env: Env): Promise<{ size: number, keys: string[] }> {
    if (!env.IMAGE_CACHE_KV) {
      return { size: 0, keys: [] };
    }

    try {
      const fullKeys = await this.listKeys(env);
      // 将完整键转换为原始键（去除前缀）
      const keys = fullKeys.map(key => this.extractOriginalKey(key));
      
      return {
        size: keys.length,
        keys
      };
    } catch (error) {
      console.error('获取缓存统计信息失败:', error);
      return { size: 0, keys: [] };
    }
  }
}
