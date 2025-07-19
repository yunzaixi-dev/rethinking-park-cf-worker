/**
 * AI服务模块
 * 提供图像AI分析功能
 */
import { DetectedElement, Detection } from '../types/detection';
import { Env } from '../types/env';
import { getImageDimensions } from './image';

/**
 * 使用AI分析图像内容
 * 调用Cloudflare AI的对象检测模型，分析图像并返回检测到的元素
 * 
 * @param imageBuffer - 图像的二进制数据
 * @param env - 环境变量和绑定资源
 * @returns 包含检测到的元素和图像信息的对象
 */
export async function analyzeImageWithAI(imageBuffer: ArrayBuffer, env: Env): Promise<{elements: DetectedElement[], imageInfo: {width: number, height: number, format: string, size: number}}> {
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
	} catch (error) {
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
