/**
 * AI服务模块 - Replicate集成
 * 提供图像AI分析功能
 */
import { DetectedElement } from '../types/detection';
import { Env } from '../types/env';
import { getImageDimensions } from './image';

/**
 * Replicate API创建预测响应接口
 */
interface ReplicatePredictionResponse {
  id: string;
}

/**
 * Replicate API预测结果响应接口
 */
interface ReplicatePredictionResultResponse {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: YoloWorldOutput;
  error?: string;
}

/**
 * YOLO-World 模型输出接口
 */
interface YoloWorldOutput {
  json_str: string;
  media_path: string;
}

/**
 * YOLO-World JSON 检测结果接口
 */
interface YoloWorldDetection {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
  cls: string;
}

/**
 * YOLO-World 返回的检测结果对象
 */
interface YoloWorldDetections {
  [key: string]: YoloWorldDetection;
}

/**
 * Replicate API模型信息响应接口
 */
interface ReplicateModelResponse {
  latest_version?: {
    id: string;
  };
}



/**
 * 使用Replicate AI分析图像内容
 * 调用Replicate的目标检测模型，分析图像并返回检测到的元素
 * 
 * @param imageBuffer - 图像的二进制数据
 * @param env - 环境变量和绑定资源
 * @returns 包含检测到的元素和图像信息的对象
 */
export async function analyzeImageWithAI(imageBuffer: ArrayBuffer, env: Env): Promise<{ elements: DetectedElement[], imageInfo: { width: number, height: number, format: string, size: number } }> {
  try {
    console.log('Starting Replicate AI image analysis...');

    // 获取图像尺寸
    const dimensions = await getImageDimensions(imageBuffer);
    console.log('Image dimensions:', dimensions);

    // 将图像转换为base64 - 检测实际格式
    const imageFormat = detectImageFormat(imageBuffer);
    const base64Image = arrayBufferToBase64(imageBuffer);
    const dataUri = `data:${imageFormat};base64,${base64Image}`;

    // 使用固定的 YOLO-World XL 模型
    const model = 'franz-biz/yolo-world-xl';
    const apiUrl = `https://api.replicate.com/v1/predictions`;

    console.log(`Calling Replicate API with YOLO-World XL model`);

    // 获取模型配置
    const modelConfig = await getYoloWorldConfig(model, env.REPLICATE_API_TOKEN);

    // 调用Replicate API - 先尝试不使用自定义输入参数
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: modelConfig.version,
        input: {
          input_media: dataUri,
          class_names: modelConfig.input.class_names,
          max_num_boxes: modelConfig.input.max_num_boxes,
          score_thr: modelConfig.input.score_thr,
          nms_thr: modelConfig.input.nms_thr,
          return_json: modelConfig.input.return_json
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Replicate API error: ${response.status} ${response.statusText}`);
    }

    const prediction = (await response.json()) as ReplicatePredictionResponse;
    console.log('Replicate prediction created:', prediction.id);

    // 等待预测完成
    const result = await waitForPrediction(prediction.id, env.REPLICATE_API_TOKEN);
    console.log('Replicate analysis complete:', result);

    // 将YOLO-World响应转换为我们的格式
    const elements: DetectedElement[] = [];

    console.log('Full Replicate result:', JSON.stringify(result, null, 2));
    
    if (result.output && result.output.json_str) {
      try {
        console.log('Raw JSON string from YOLO-World:', result.output.json_str);
        const detectionsObj = JSON.parse(result.output.json_str) as YoloWorldDetections;
        console.log('Parsed detections object:', detectionsObj);
        
        // 将对象转换为数组并处理每个检测结果
        for (const [detKey, detection] of Object.entries(detectionsObj)) {
          console.log(`Processing detection ${detKey}:`, detection);
          
          // YOLO-World 返回的是 {x0, y0, x1, y1} 格式的像素坐标
          const { x0, y0, x1, y1, score, cls } = detection;
          
          // 将像素坐标转换为归一化坐标
          const bbox = {
            x: x0 / dimensions.width,
            y: y0 / dimensions.height,
            width: (x1 - x0) / dimensions.width,
            height: (y1 - y0) / dimensions.height
          };

          // 验证坐标范围
          if (bbox.x >= 0 && bbox.y >= 0 && bbox.width > 0 && bbox.height > 0 &&
            bbox.x + bbox.width <= 1 && bbox.y + bbox.height <= 1) {

            elements.push({
              type: cls,
              confidence: score,
              description: `${cls} (confidence: ${(score * 100).toFixed(1)}%)`,
              bbox
            });

            console.log('Added detection:', {
              type: cls,
              confidence: score,
              bbox
            });
          } else {
            console.log('Skipped detection with invalid bbox:', { cls, score, bbox });
          }
        }
      } catch (error) {
        console.error('Failed to parse YOLO-World JSON output:', error, 'Raw output:', result.output.json_str);
      }
    } else {
      console.log('No JSON output from YOLO-World, full output:', result.output);
    }

    // 如果没有检测到对象，提供回退响应
    if (elements.length === 0) {
      console.log('No objects detected, using fallback response');
      elements.push({
        type: 'scene',
        confidence: 0.5,
        description: 'General scene detected',
        bbox: { x: 0, y: 0, width: 1, height: 1 }
      });
    }

    const imageInfo = {
      width: dimensions.width,
      height: dimensions.height,
      format: 'image/jpeg',
      size: imageBuffer.byteLength
    };

    console.log('Replicate analysis complete:', {
      elements: elements.length,
      imageInfo,
      detectedObjects: elements.map(e => `${e.type} (${(e.confidence * 100).toFixed(1)}%)`)
    });

    return { elements, imageInfo };

  } catch (error) {
    console.error('Replicate AI detection failed:', error);

    const errorMessage = error instanceof Error
      ? `Replicate分析失败: ${error.message}`
      : '图像分析服务出现未知错误';

    throw new Error(errorMessage);
  }
}

/**
 * 获取 YOLO-World XL 模型的版本号和配置
 */
async function getYoloWorldConfig(model: string, apiToken: string): Promise<{ version: string, input: any }> {
  // YOLO-World XL 模型配置
  const config = {
    version: null as string | null,
    input: {
      input_media: '', // 将在调用时设置
      class_names: 'cloud, human, light, sky, stream, hill, stone, insect, squirrel, dead branch, tree, leaf, tree shade, river, pond, bush, dog, cat, flower, grass, fallen leaf, sunshine, shadow, rain, bird, duck', // ReThinking Park 指定元素
      max_num_boxes: 100,
      score_thr: 0.05,
      nms_thr: 0.5,
      return_json: true
    }
  };

  // 动态获取最新版本，带重试机制
  let retryCount = 0;
  const maxRetries = 3;
  
  while (retryCount < maxRetries && !config.version) {
    try {
      console.log(`Fetching YOLO-World model version (attempt ${retryCount + 1}/${maxRetries})`);
      
      const response = await fetch(`https://api.replicate.com/v1/models/${model}`, {
        headers: {
          'Authorization': `Token ${apiToken}`,
          'Accept': 'application/json',
          'User-Agent': 'rethinking-park-worker/1.0'
        },
        signal: AbortSignal.timeout(10000) // 10秒超时
      });

      if (response.ok) {
        const modelData = (await response.json()) as ReplicateModelResponse;
        if (modelData.latest_version?.id) {
          config.version = modelData.latest_version.id;
          console.log(`Successfully retrieved model version: ${config.version}`);
          break;
        } else {
          console.warn('Model response missing version info');
        }
      } else {
        console.warn(`Model API returned ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.warn(`Attempt ${retryCount + 1} failed:`, error instanceof Error ? error.message : 'Unknown error');
    }
    
    retryCount++;
    if (retryCount < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // 递增延迟
    }
  }

  // 如果仍然没有版本号，使用固定的稳定版本
  if (!config.version) {
    // 使用正确的 franz-biz/yolo-world-xl 版本ID
    config.version = 'fd1305d3fc19e81540542f51c2530cf8f393e28cc6ff4976337c3e2b75c7c292'; // 正确的版本ID
    console.warn(`Using fallback version: ${config.version}`);
  }

  return config as { version: string, input: any };
}

/**
 * 等待Replicate预测完成
 */
async function waitForPrediction(predictionId: string, apiToken: string, maxWait: number = 30000): Promise<ReplicatePredictionResultResponse> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: {
        'Authorization': `Token ${apiToken}`,
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to check prediction status: ${response.status}`);
    }

    const prediction = (await response.json()) as ReplicatePredictionResultResponse;

    if (prediction.status === 'succeeded') {
      return prediction;
    } else if (prediction.status === 'failed') {
      throw new Error(`Prediction failed: ${prediction.error}`);
    }

    // 等待1秒后重试
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Prediction timeout');
}

/**
 * 检测图像格式
 */
function detectImageFormat(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  
  // PNG
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return 'image/png';
  }
  
  // JPEG
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }
  
  // WebP
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  
  // 默认返回JPEG
  return 'image/jpeg';
}

/**
 * 将ArrayBuffer转换为base64
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}