/**
 * 环境变量接口
 * 定义Cloudflare Worker可访问的环境变量和绑定
 */
export interface Env {
	// Replicate API配置
	REPLICATE_API_TOKEN: string;  // Replicate API访问令牌
	REPLICATE_MODEL?: string;     // 要使用的Replicate模型（默认: daanelson/yolov5）
	
	// 应用配置
	CACHE_TTL: string;       // 缓存生存时间（秒）
	MAX_FILE_SIZE: string;   // 最大允许的文件大小（字节）
	CACHE_ENABLED?: string;  // 设置为"false"以禁用缓存功能
	
	// KV存储
	RATE_LIMIT_KV?: any;     // KV命名空间，用于存储速率限制数据
	IMAGE_CACHE_KV?: any;    // KV命名空间，用于存储图像分析结果缓存
}
