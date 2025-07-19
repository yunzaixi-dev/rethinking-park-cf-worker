import { DetectedElement } from './detection';

/**
 * 分析结果接口
 * 定义图像分析操作返回的数据结构
 */
export interface AnalysisResult {
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
 * 定义所有API端点返回的标准响应格式
 */
export interface APIResponse {
	success: boolean;          // 请求是否成功处理
	analysis?: AnalysisResult; // 成功时返回的分析结果
	error?: string;            // 失败时返回的错误信息
	timestamp: string;         // 响应生成的时间戳（ISO格式）
}
