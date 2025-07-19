/**
 * ReThinking Park - Cloudflare Worker AI 后端
 * 
 * 该Worker提供基于Cloudflare AI的图像分析服务
 * 用于ReThinking Park项目
 * 
 * 主要功能：
 * 1. 图像识别与分析（使用AI检测图像中的元素）
 * 2. 结果缓存（提高性能并减少API调用）
 * 3. 请求速率限制（防止滥用）
 * 4. 跨域资源共享（CORS）支持
 * 5. 健康检查端点
 * 6. 缓存管理功能
 */

/**
 * 环境变量接口
 * 定义Worker运行时需要访问的环境变量和绑定资源
 */
interface Env {
	AI: Ai;                  // Cloudflare AI绑定，提供AI模型访问
	CACHE_TTL: string;       // 缓存生存时间（秒）
	MAX_FILE_SIZE: string;   // 最大允许的文件大小（字节）
	CACHE_ENABLED?: string;  // 设置为"false"以禁用缓存功能
	RATE_LIMIT_KV?: KVNamespace; // KV命名空间，用于存储速率限制数据
}

/**
 * 检测到的元素接口
 * 定义从图像中检测到的单个元素的结构
 */
interface DetectedElement {
	type: string;        // 元素类型（如树、草地、建筑等）
	confidence: number;  // 置信度（0-1之间的浮点数）
	description?: string; // 可选的元素描述文本
	bbox?: {             // 可选的边界框（bounding box），定义元素在图像中的位置
		x: number;        // 左上角X坐标（像素）
		y: number;        // 左上角Y坐标（像素）
		width: number;    // 宽度（像素）
		height: number;   // 高度（像素）
	};
}

/**
 * AI模型返回的原始检测结果类型
 * 定义AI模型API返回的原始检测数据结构
 */
interface Detection {
	score?: number;   // 检测置信度分数（0-1之间的浮点数）
	label?: string;   // 检测到的对象标签/类别
	box?: {           // 归一化坐标中的边界框（值在0-1之间）
		xmin: number;  // 左边界（归一化）
		ymin: number;  // 上边界（归一化）
		xmax: number;  // 右边界（归一化）
		ymax: number;  // 下边界（归一化）
	};
}

/**
 * 分析结果接口
 * 定义图像分析完成后返回的完整结果结构
 */
interface AnalysisResult {
	elements: DetectedElement[]; // 检测到的元素数组
	processingTime: string;     // 处理时间（毫秒）
	timestamp: string;          // 分析完成的时间戳（ISO格式）
	imageHash: string;          // 图像内容的唯一哈希值（用于缓存）
	cacheHit: boolean;          // 是否命中缓存的标志
	imageInfo: {                // 图像的元数据信息
		width: number;          // 图像宽度（像素）
		height: number;         // 图像高度（像素）
		format: string;         // 图像格式（如'jpeg'、'png'）
		size: number;           // 图像大小（字节）
	};
}

/**
 * API响应接口
 * 定义API端点返回给客户端的响应结构
 */
interface APIResponse {
	success: boolean;          // 请求是否成功处理
	analysis?: AnalysisResult; // 成功时返回的分析结果
	error?: string;            // 失败时返回的错误信息
	timestamp: string;         // 响应生成的时间戳（ISO格式）
}

/**
 * 简单的内存缓存
 * 用于存储分析结果，以图像哈希为键
 * 注意：每次Worker冷启动时会重置
 */
const cache = new Map<string, AnalysisResult>();

/**
 * 速率限制配置
 * 定义API请求速率限制参数
 */
const RATE_LIMIT_CONFIG = {
	requests: 100, // 每个时间窗口内允许的请求数
	window: 3600,  // 时间窗口大小（秒，当前设置为1小时）
	blockDuration: 1800 // 超出限制后的封禁时长（秒，当前设置为30分钟）
};

/**
 * 检查请求源是否被允许
 * 实现CORS（跨域资源共享）策略，验证请求源是否在白名单中
 * 
 * @param origin - 请求头中的Origin值
 * @returns 如果请求源在允许列表中返回true，否则返回false
 */
function isOriginAllowed(origin: string | null): boolean {
	if (!origin) return false;
	
	const allowedOrigins = [
		'https://rethinkingpark.com',
		'https://www.rethinkingpark.com',
		'http://localhost:5173', // Vite dev server
		'http://localhost:3000', // React dev server
		'http://127.0.0.1:5173',
		'http://127.0.0.1:3000'
	];
	
	return allowedOrigins.includes(origin);
}

/**
 * 获取客户端IP地址
 * 尝试从各种请求头中提取客户端的真实IP地址
 * 
 * @param request - 接收到的HTTP请求对象
 * @returns 客户端IP地址字符串，如果无法确定则返回'unknown'
 */
function getClientIP(request: Request): string {
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
async function checkRateLimit(ip: string, env: Env): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
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

/**
 * 计算图像数据的稳健哈希值
 * 使用图像内容的SHA-256哈希，结合图像大小信息，确保不同图像获得不同的哈希值
 * 此哈希用于缓存键和图像唯一标识
 * 
 * @param imageData - 图像的二进制数据
 * @returns 图像内容的哈希字符串
 */
async function calculateImageHash(imageData: ArrayBuffer): Promise<string> {
	// Create a more robust hash by including both content and size
	const contentHash = await crypto.subtle.digest('SHA-256', imageData);
	const contentArray = new Uint8Array(contentHash);
	
	// Add file size to the hash to make it more unique
	const sizeBytes = new Uint8Array(new ArrayBuffer(4));
	new DataView(sizeBytes.buffer).setUint32(0, imageData.byteLength, false);
	
	// Combine content hash with size
	const combinedData = new Uint8Array(contentArray.length + sizeBytes.length);
	combinedData.set(contentArray);
	combinedData.set(sizeBytes, contentArray.length);
	
	// Create final hash
	const finalHash = await crypto.subtle.digest('SHA-256', combinedData);
	const finalArray = new Uint8Array(finalHash);
	
	const hashString = Array.from(finalArray).map(b => b.toString(16).padStart(2, '0')).join('');
	console.log('Generated image hash:', hashString.substring(0, 16) + '...', 'for', imageData.byteLength, 'bytes');
	
	return hashString;
}

/**
 * 验证图像格式和大小
 * 检查上传的文件是否是支持的图像格式，且大小在允许范围内
 * 
 * @param file - 上传的文件对象
 * @param maxSize - 允许的最大文件大小（字节）
 * @returns 包含验证结果和可能的错误信息的对象
 */
function validateImage(file: File, maxSize: number): { valid: boolean; error?: string } {
	// Check file size
	if (file.size > maxSize) {
		return { valid: false, error: `File size ${file.size} exceeds maximum allowed size of ${maxSize} bytes` };
	}
	
	// Check file type
	const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
	if (!validTypes.includes(file.type)) {
		return { valid: false, error: `Invalid image format: ${file.type}. Supported formats: JPEG, PNG, WebP` };
	}
	
	return { valid: true };
}

/**
 * 从图像缓冲区解析头部信息获取图像尺寸
 * 支持PNG、JPEG和WebP格式，通过直接解析文件头获取宽高信息
 * 避免完整解码图像，提高性能
 * 
 * @param imageBuffer - 图像的二进制数据
 * @returns 包含图像宽度和高度的对象
 */
async function getImageDimensions(imageBuffer: ArrayBuffer): Promise<{width: number, height: number}> {
	console.log('Parsing image dimensions from headers...');
	
	const view = new DataView(imageBuffer);
	const bufferSize = imageBuffer.byteLength;
	
	console.log('Image buffer size:', bufferSize, 'bytes');
	
	try {
		// PNG signature: 89 50 4E 47 0D 0A 1A 0A
		if (view.getUint32(0) === 0x89504E47 && view.getUint32(4) === 0x0D0A1A0A) {
			console.log('Detected PNG format');
			// PNG IHDR chunk starts at byte 16, width and height are at bytes 16-19 and 20-23
			const width = view.getUint32(16);
			const height = view.getUint32(20);
			console.log('PNG dimensions:', width, 'x', height);
			return { width, height };
		}
		
		// JPEG signature: FF D8 FF
		if (view.getUint8(0) === 0xFF && view.getUint8(1) === 0xD8 && view.getUint8(2) === 0xFF) {
			console.log('Detected JPEG format');
			let offset = 2;
			
			while (offset < bufferSize - 4) {
				// Find SOF0 (Start of Frame) marker: FF C0
				if (view.getUint8(offset) === 0xFF && view.getUint8(offset + 1) === 0xC0) {
					// Height is at offset + 5, width at offset + 7 (big-endian)
					const height = view.getUint16(offset + 5);
					const width = view.getUint16(offset + 7);
					console.log('JPEG dimensions:', width, 'x', height);
					return { width, height };
				}
				offset++;
			}
		}
		
		// WebP signature: RIFF ... WEBP
		if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
			console.log('Detected WebP format');
			// Simple WebP VP8 format
			if (view.getUint32(12) === 0x56503820) {
				// Skip to width/height data
				const width = (view.getUint16(26) & 0x3FFF) + 1;
				const height = (view.getUint16(28) & 0x3FFF) + 1;
				console.log('WebP dimensions:', width, 'x', height);
				return { width, height };
			}
		}
		
		console.log('Could not parse image dimensions, using fallback');
	} catch (error) {
		console.error('Error parsing image dimensions:', error);
	}
	
	// Fallback: Estimate based on file size
	if (bufferSize > 5000000) { // Large image > 5MB
		return { width: 3840, height: 2160 }; // 4K
	} else if (bufferSize > 1000000) { // Medium image > 1MB
		return { width: 1920, height: 1080 }; // Full HD
	} else {
		return { width: 1280, height: 720 }; // HD
	}
}


/**
 * 使用AI分析图像内容
 * 调用Cloudflare AI的对象检测模型，分析图像并返回检测到的元素
 * 
 * @param imageBuffer - 图像的二进制数据
 * @param env - 环境变量和绑定资源
 * @returns 包含检测到的元素和图像信息的对象
 */
async function analyzeImageWithAI(imageBuffer: ArrayBuffer, env: Env): Promise<{elements: DetectedElement[], imageInfo: {width: number, height: number, format: string, size: number}}> {
	try {
		console.log('Starting real AI image analysis...');
		
		// 获取图像尺寸
		const dimensions = await getImageDimensions(imageBuffer);
		
		// 使用Cloudflare AI进行实际目标检测
		const inputs = {
			image: Array.from(new Uint8Array(imageBuffer))
		};
		
		console.log('Calling Cloudflare AI object detection...');
		const response = await env.AI.run('@cf/facebook/detr-resnet-50', inputs);
		
		console.log('AI Response:', response);
		
		// 将AI响应转换为我们的格式
		const elements: DetectedElement[] = [];
		
		if (response && Array.isArray(response)) {
			for (const detection of response as Detection[]) {
				if (detection.label && detection.score && detection.box) {
					// Convert normalized coordinates to pixel coordinates
					const bbox = {
						x: Math.round(detection.box.xmin * dimensions.width),
						y: Math.round(detection.box.ymin * dimensions.height),
						width: Math.round((detection.box.xmax - detection.box.xmin) * dimensions.width),
						height: Math.round((detection.box.ymax - detection.box.ymin) * dimensions.height)
					};
					
					elements.push({
						type: detection.label,
						confidence: detection.score,
						description: `${detection.label} (confidence: ${(detection.score * 100).toFixed(1)}%)`,
						bbox
					});
				}
			}
		}
		
		// 如果没有检测到对象，提供回退响应
		if (elements.length === 0) {
			console.log('No objects detected, using fallback response');
			elements.push({
				type: 'scene',
				confidence: 0.5,
				description: 'General scene detected',
				bbox: { x: 0, y: 0, width: dimensions.width, height: dimensions.height }
			});
		}
		
		const imageInfo = {
			width: dimensions.width,
			height: dimensions.height,
			format: 'image/png', // Simplified - would be detected from headers
			size: imageBuffer.byteLength
		};
		
		console.log('Image analysis complete:', {
			elements: elements.length,
			imageInfo,
			detectedObjects: elements.map(e => `${e.type} (${(e.confidence * 100).toFixed(1)}%)`)
		});
		
		return { elements, imageInfo };
	} 	catch (error) {
		// 记录错误信息
		console.error('AI detection failed:', error);
		
		// 添加更详细的错误信息
		const errorMessage = error instanceof Error 
			? `AI分析失败: ${error.message}` 
			: '图像分析服务出现未知错误';
		
		// 直接抛出错误，让上层调用处理
		throw new Error(errorMessage);
	}
}

/**
 * 处理图像分析请求
 * 主要API端点处理函数，接收图像文件，进行验证、处理和分析
 * 实现速率限制、缓存和错误处理逻辑
 * 
 * @param request - HTTP请求对象
 * @param env - 环境变量和绑定资源
 * @returns HTTP响应对象
 */
async function handleImageAnalysis(request: Request, env: Env): Promise<Response> {
	const startTime = Date.now();
	
	try {
		// Parse form data
		const formData = await request.formData();
		const imageFile = formData.get('image') as File;
		
		if (!imageFile) {
			return Response.json({
				success: false,
				error: 'No image file provided',
				timestamp: new Date().toISOString()
			} as APIResponse, { status: 400 });
		}

		// Validate image
		const maxSize = parseInt(env.MAX_FILE_SIZE) || 10485760; // 10MB default
		const validation = validateImage(imageFile, maxSize);
		if (!validation.valid) {
			return Response.json({
				success: false,
				error: validation.error,
				timestamp: new Date().toISOString()
			} as APIResponse, { status: 400 });
		}

		// Get image data and calculate hash
		const imageBuffer = await imageFile.arrayBuffer();
		const imageHash = await calculateImageHash(imageBuffer);

		// Check cache (if enabled)
		const cacheEnabled = env.CACHE_ENABLED !== 'false';
		const cacheTTL = parseInt(env.CACHE_TTL) || 3600;
		
		if (cacheEnabled) {
			let cachedResult = cache.get(imageHash);
			if (cachedResult) {
				const age = Date.now() - new Date(cachedResult.timestamp).getTime();
				if (age < cacheTTL * 1000) {
					console.log(`Cache hit for image hash: ${imageHash}`);
					return Response.json({
						success: true,
						analysis: {
							...cachedResult,
							cacheHit: true,
							processingTime: '0ms (cached)'
						},
						timestamp: new Date().toISOString()
					} as APIResponse);
				} else {
					cache.delete(imageHash);
				}
			}
		} else {
			console.log('Cache disabled by configuration');
		}

		// Analyze image with AI
		const analysisData = await analyzeImageWithAI(imageBuffer, env);
		
		const processingTime = `${Date.now() - startTime}ms`;
		const result: AnalysisResult = {
			elements: analysisData.elements,
			processingTime,
			timestamp: new Date().toISOString(),
			imageHash,
			cacheHit: false,
			imageInfo: analysisData.imageInfo
		};

		// Store in cache (if enabled)
		if (cacheEnabled) {
			cache.set(imageHash, result);
			console.log(`Result cached for hash: ${imageHash.substring(0, 16)}...`);
		}
		
		console.log(`Image analyzed successfully. Hash: ${imageHash}, Elements: ${analysisData.elements.length}, Processing time: ${processingTime}`);

		return Response.json({
			success: true,
			analysis: result,
			timestamp: new Date().toISOString()
		} as APIResponse);

	} catch (error) {
		console.error('Image analysis error:', error);
		return Response.json({
			success: false,
			error: (error as Error).message || 'Failed to analyze image',
			timestamp: new Date().toISOString()
		} as APIResponse, { status: 500 });
	}
}

/**
 * Handle health check endpoint
 */
/**
 * 处理健康检查请求
 * 返回后端服务状态、版本信息和配置概况
 * 用于监控和调试目的
 * 
 * @param env - 环境变量和绑定资源
 * @returns 包含服务状态信息的HTTP响应
 */
function handleHealthCheck(env: Env): Response {
	const cacheEnabled = env.CACHE_ENABLED !== 'false';
	return Response.json({
		status: 'healthy',
		timestamp: new Date().toISOString(),
		cache_enabled: cacheEnabled,
		cache_size: cache.size,
		cache_ttl: parseInt(env.CACHE_TTL) || 3600,
		cache_entries: Array.from(cache.keys()).map(key => ({
			hash: key.substring(0, 16) + '...',
			timestamp: cache.get(key)?.timestamp
		})),
		service: 'ReThinking Park Cloudflare Worker'
	});
}

/**
 * Handle cache management endpoint
 */
/**
 * 处理缓存管理请求
 * 提供API端点用于查看、清除缓存信息
 * 仅供开发和管理目的使用
 * 
 * @param request - HTTP请求对象
 * @returns HTTP响应对象
 */
function handleCacheManagement(request: Request): Response {
	const url = new URL(request.url);
	const action = url.searchParams.get('action');
	
	switch (action) {
		case 'clear':
			const oldSize = cache.size;
			cache.clear();
			console.log(`Cache cleared. Removed ${oldSize} entries.`);
			return Response.json({
				success: true,
				message: `Cache cleared. Removed ${oldSize} entries.`,
				timestamp: new Date().toISOString()
			});
			
		case 'size':
			return Response.json({
				cache_size: cache.size,
				entries: Array.from(cache.keys()).map(key => {
					const entry = cache.get(key);
					return {
						hash: key.substring(0, 16) + '...',
						timestamp: entry?.timestamp,
						elements_count: entry?.elements.length,
						processing_time: entry?.processingTime
					};
				}),
				timestamp: new Date().toISOString()
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
			
			// Find full hash that starts with provided prefix
			const fullHash = Array.from(cache.keys()).find(key => key.startsWith(hashToDelete));
			if (fullHash && cache.delete(fullHash)) {
				console.log(`Cache entry deleted: ${fullHash.substring(0, 16)}...`);
				return Response.json({
					success: true,
					message: `Cache entry deleted: ${fullHash.substring(0, 16)}...`,
					timestamp: new Date().toISOString()
				});
			} else {
				return Response.json({
					success: false,
					error: 'Cache entry not found',
					timestamp: new Date().toISOString()
				}, { status: 404 });
			}
			
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

/**
 * Handle CORS preflight requests
 */
/**
 * 处理OPTIONS请求
 * 实现CORS预检请求（preflight）响应
 * 允许跨域资源请求所需的HTTP方法和头部
 * 
 * @param request - HTTP请求对象
 * @returns 适当的OPTIONS响应对象
 */
function handleOptions(request: Request): Response {
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
 * Add CORS headers to response
 */
/**
 * 向响应添加CORS头部
 * 为所有API响应添加正确的跨域资源共享头部
 * 
 * @param response - 原始HTTP响应对象
 * @param request - 相关的HTTP请求对象
 * @returns 添加了CORS头部的新响应对象
 */
function addCorsHeaders(response: Response, request: Request): Response {
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
				response = handleHealthCheck(env);
				break;
				
			case '/api/v1/cache':
				if (request.method !== 'GET') {
					response = Response.json({
						success: false,
						error: 'Method not allowed. Use GET with query parameters.',
						timestamp: new Date().toISOString()
					} as APIResponse, { status: 405 });
				} else {
					response = handleCacheManagement(request);
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
			
			case '/':
				response = new Response(`
					<!DOCTYPE html>
					<html>
					<head>
						<title>ReThinking Park API</title>
						<style>
							body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
							.endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; }
							.method { background: #007acc; color: white; padding: 2px 8px; border-radius: 3px; font-size: 12px; }
						</style>
					</head>
					<body>
						<h1>🌳 ReThinking Park API</h1>
						<p>Powered by Cloudflare Workers AI (Demo Mode)</p>
						
						<h2>Available Endpoints:</h2>
						
						<div class="endpoint">
							<span class="method">GET</span>
							<strong>/api/v1/health</strong>
							<p>Health check endpoint with cache information</p>
						</div>
						
						<div class="endpoint">
							<span class="method">GET</span>
							<strong>/api/v1/cache</strong>
							<p>Cache management endpoint</p>
							<ul>
								<li><code>?action=size</code> - Show cache size and entries</li>
								<li><code>?action=clear</code> - Clear all cache entries</li>
								<li><code>?action=delete&hash=PREFIX</code> - Delete specific entry</li>
							</ul>
						</div>
						
						<div class="endpoint">
							<span class="method">POST</span>
							<strong>/api/v1/analyze</strong>
							<p>Image analysis endpoint. Send image as form-data with key "image"</p>
						</div>
						
						<h2>Usage Example:</h2>
						<pre>curl -X POST -F "image=@your-image.jpg" ${url.origin}/api/v1/analyze</pre>
						
						<p><em>Built with ❤️ for ReThinking Parks</em></p>
					</body>
					</html>
				`, {
					headers: { 'Content-Type': 'text/html' }
				});
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
} satisfies ExportedHandler<Env>;