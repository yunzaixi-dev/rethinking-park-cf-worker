/**
 * 检测元素接口
 * 定义图像中检测到的对象或元素的结构
 */
export interface DetectedElement {
	type: string;        // 元素类型（如树、草地、建筑等）
	confidence: number;  // 置信度（0-1之间的浮点数）
	description?: string; // 可选的元素描述文本
	bbox?: {             // 可选的边界框（bounding box），定义元素在图像中的位置（归一化坐标 0-1）
		x: number;        // 左上角X坐标（归一化，0-1）
		y: number;        // 左上角Y坐标（归一化，0-1）
		width: number;    // 宽度（归一化，0-1）
		height: number;   // 高度（归一化，0-1）
	};
}

/**
 * AI检测结果接口
 * 表示从AI模型接收到的原始检测数据结构
 */
export interface Detection {
	score?: number;   // 检测置信度分数（0-1之间的浮点数）
	label?: string;   // 检测到的对象标签/类别
	box?: {           // 归一化坐标中的边界框（值在0-1之间）
		xmin: number;  // 左边界（归一化）
		ymin: number;  // 上边界（归一化）
		xmax: number;  // 右边界（归一化）
		ymax: number;  // 下边界（归一化）
	};
}
