/**
 * 图像分析处理程序
 * 处理图像上传和AI分析请求
 */
import { APIResponse, AnalysisResult } from '../types/api';
import { Env } from '../types/env';
import { analyzeImageWithAI } from '../services/ai';
import { calculateImageHash, validateImage } from '../services/image';
import { CacheService } from '../services/cache';

/**
 * 处理图像分析请求
 * 接收图像上传，验证，分析并返回结果
 * 支持缓存以提高性能
 * 
 * @param request - HTTP请求对象
 * @param env - 环境变量和绑定资源
 * @returns 包含分析结果或错误信息的HTTP响应
 */
export async function handleImageAnalysis(request: Request, env: Env): Promise<Response> {
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
			// 从KV缓存中获取分析结果
			const cachedResult = await CacheService.get(env, imageHash);
			
			if (cachedResult) {
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
			await CacheService.set(env, imageHash, result);
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
