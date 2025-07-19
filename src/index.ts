/**
 * ReThinking Park - Cloudflare Worker AI Backend
 * 
 * This worker provides image analysis services using Cloudflare AI
 * for the ReThinking Park project.
 */

interface Env {
	AI: Ai;
	CACHE_TTL: string;
	MAX_FILE_SIZE: string;
}

// Nature elements that we want to detect and classify
const NATURE_ELEMENTS = new Set([
	'tree', 'water', 'mountain', 'sky', 'grass', 'flower', 'rock', 'cloud',
	'leaf', 'branch', 'plant', 'forest', 'lake', 'river', 'ocean', 'beach',
	'sand', 'stone', 'wood', 'nature', 'landscape', 'outdoor', 'garden',
	'park', 'field', 'meadow', 'hill', 'valley', 'sunset', 'sunrise',
	'shadow', 'sunlight', 'bird', 'animal', 'wildlife', 'vegetation',
	'bushes', 'moss', 'fern', 'flowers', 'greenery', 'foliage'
]);

interface DetectedElement {
	type: string;
	confidence: number;
	description?: string;
}

interface AnalysisResult {
	elements: DetectedElement[];
	processingTime: string;
	timestamp: string;
	imageHash: string;
	cacheHit: boolean;
}

interface APIResponse {
	success: boolean;
	analysis?: AnalysisResult;
	error?: string;
	timestamp: string;
}

// Simple in-memory cache (will be reset on each cold start)
const cache = new Map<string, AnalysisResult>();

/**
 * Calculate a simple hash for the image data
 */
async function calculateImageHash(imageData: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', imageData);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate image format and size
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
 * Analyze image using Cloudflare AI
 */
async function analyzeImageWithAI(imageBuffer: ArrayBuffer, env: Env): Promise<DetectedElement[]> {
	try {
		// Use Cloudflare AI image classification
		const response = await env.AI.run(
			'@cf/microsoft/resnet-50',
			{
				image: Array.from(new Uint8Array(imageBuffer))
			}
		);

		console.log('AI Response:', JSON.stringify(response, null, 2));

		// Process the AI response to extract nature elements
		const elements: DetectedElement[] = [];
		
		if (response && Array.isArray(response)) {
			for (const item of response) {
				if (item.label && item.score) {
					const label = item.label.toLowerCase();
					
					// Check if this label corresponds to a nature element
					for (const natureElement of NATURE_ELEMENTS) {
						if (label.includes(natureElement) || natureElement.includes(label)) {
							elements.push({
								type: natureElement,
								confidence: item.score,
								description: item.label
							});
							break; // Only add one match per AI result
						}
					}
				}
			}
		}

		// If no nature elements found, try to infer from common classifications
		if (elements.length === 0 && response && Array.isArray(response)) {
			// Add some common nature interpretations
			for (const item of response) {
				if (item.label && item.score > 0.1) {
					const label = item.label.toLowerCase();
					if (label.includes('outdoor') || label.includes('natural') || label.includes('green')) {
						elements.push({
							type: 'nature',
							confidence: item.score * 0.8, // Reduce confidence for inferred elements
							description: `Inferred from: ${item.label}`
						});
						break;
					}
				}
			}
		}

		return elements;
	} catch (error) {
		console.error('AI analysis failed:', error);
		throw new Error(`Image analysis failed: ${error.message}`);
	}
}

/**
 * Handle image analysis endpoint
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

		// Check cache
		const cacheTTL = parseInt(env.CACHE_TTL) || 3600;
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

		// Analyze image with AI
		const elements = await analyzeImageWithAI(imageBuffer, env);
		
		const processingTime = `${Date.now() - startTime}ms`;
		const result: AnalysisResult = {
			elements,
			processingTime,
			timestamp: new Date().toISOString(),
			imageHash,
			cacheHit: false
		};

		// Store in cache
		cache.set(imageHash, result);
		
		console.log(`Image analyzed successfully. Hash: ${imageHash}, Elements: ${elements.length}, Processing time: ${processingTime}`);

		return Response.json({
			success: true,
			analysis: result,
			timestamp: new Date().toISOString()
		} as APIResponse);

	} catch (error) {
		console.error('Image analysis error:', error);
		return Response.json({
			success: false,
			error: error.message || 'Failed to analyze image',
			timestamp: new Date().toISOString()
		} as APIResponse, { status: 500 });
	}
}

/**
 * Handle health check endpoint
 */
function handleHealthCheck(): Response {
	return Response.json({
		status: 'healthy',
		timestamp: new Date().toISOString(),
		cache_size: cache.size,
		service: 'ReThinking Park Cloudflare Worker'
	});
}

/**
 * Handle CORS preflight requests
 */
function handleOptions(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Max-Age': '86400',
		},
	});
}

/**
 * Add CORS headers to response
 */
function addCorsHeaders(response: Response): Response {
	const newResponse = new Response(response.body, response);
	newResponse.headers.set('Access-Control-Allow-Origin', '*');
	newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type');
	return newResponse;
}

/**
 * Main worker handler
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		
		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return handleOptions();
		}

		let response: Response;

		switch (url.pathname) {
			case '/api/v1/health':
				response = handleHealthCheck();
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
						<p>Powered by Cloudflare Workers AI</p>
						
						<h2>Available Endpoints:</h2>
						
						<div class="endpoint">
							<span class="method">GET</span>
							<strong>/api/v1/health</strong>
							<p>Health check endpoint</p>
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

		return addCorsHeaders(response);
	},
} satisfies ExportedHandler<Env>;