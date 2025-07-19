/**
 * 图像处理服务
 * 提供图像维度解析、格式验证和哈希计算等功能
 */

/**
 * 从图像缓冲区解析头部信息获取图像尺寸
 * 支持PNG、JPEG和WebP格式，通过直接解析文件头获取宽高信息
 * 
 * @param imageBuffer - 图像的二进制数据
 * @returns 包含图像宽度和高度的对象
 */
export async function getImageDimensions(imageBuffer: ArrayBuffer): Promise<{width: number, height: number}> {
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
	
	// Fallback dimensions if parsing fails
	return { width: 800, height: 600 };
}

/**
 * 计算图像哈希值
 * 根据图像内容和大小生成唯一的哈希值，用于缓存和标识
 * 
 * @param imageData - 图像的二进制数据
 * @returns 十六进制的哈希字符串
 */
export async function calculateImageHash(imageData: ArrayBuffer): Promise<string> {
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
export function validateImage(file: File, maxSize: number): { valid: boolean; error?: string } {
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
