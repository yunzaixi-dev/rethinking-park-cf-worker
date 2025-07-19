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
	CACHE_ENABLED?: string;  // Set to "false" to disable caching
	RATE_LIMIT_KV?: KVNamespace;
}

interface DetectedElement {
	type: string;
	confidence: number;
	description?: string;
	bbox?: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
}

interface AnalysisResult {
	elements: DetectedElement[];
	processingTime: string;
	timestamp: string;
	imageHash: string;
	cacheHit: boolean;
	imageInfo: {
		width: number;
		height: number;
		format: string;
		size: number;
	};
}

interface APIResponse {
	success: boolean;
	analysis?: AnalysisResult;
	error?: string;
	timestamp: string;
}

// Simple in-memory cache (will be reset on each cold start)
const cache = new Map<string, AnalysisResult>();

// Rate limiting configuration
const RATE_LIMIT_CONFIG = {
	requests: 100, // requests per window
	window: 3600,  // window in seconds (1 hour)
	blockDuration: 1800 // block duration in seconds (30 minutes)
};

/**
 * Check if origin is allowed
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
 * Get client IP address
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
 * Check rate limit for IP
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
 * Calculate a robust hash for the image data
 * Uses SHA-256 of the actual image content to ensure different images get different hashes
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
 * Create demo response for fast testing
 * Coordinates are based on the example park image (3840x2160)
 */
async function createDemoResponse(): Promise<DetectedElement[]> {
	console.log('Using demo mode for fast response...');
	
	// Return mock detection results with coordinates scaled for 3840x2160 image
	return [
		{
			type: 'tree',
			confidence: 0.85,
			description: 'Large tree in park (Demo)',
			bbox: { x: 1200, y: 400, width: 800, height: 1200 }
		},
		{
			type: 'grass',
			confidence: 0.72,
			description: 'Grass area (Demo)',
			bbox: { x: 400, y: 1600, width: 2800, height: 500 }
		},
		{
			type: 'sky',
			confidence: 0.91,
			description: 'Sky area (Demo)',
			bbox: { x: 0, y: 0, width: 3840, height: 800 }
		},
		{
			type: 'path',
			confidence: 0.68,
			description: 'Walking path (Demo)',
			bbox: { x: 2400, y: 1200, width: 1200, height: 600 }
		},
		{
			type: 'building',
			confidence: 0.79,
			description: 'Building structure (Demo)',
			bbox: { x: 2800, y: 600, width: 800, height: 900 }
		}
	];
}

/**
 * Get image dimensions from buffer by parsing headers
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
 * Analyze image using Cloudflare AI
 */
async function analyzeImageWithAI(imageBuffer: ArrayBuffer, env: Env): Promise<{elements: DetectedElement[], imageInfo: {width: number, height: number, format: string, size: number}}> {
	try {
		console.log('Starting real AI image analysis...');
		
		// Get image dimensions
		const dimensions = await getImageDimensions(imageBuffer);
		
		// Use Cloudflare AI for real object detection
		const inputs = {
			image: Array.from(new Uint8Array(imageBuffer))
		};
		
		console.log('Calling Cloudflare AI object detection...');
		const response = await env.AI.run('@cf/facebook/detr-resnet-50', inputs);
		
		console.log('AI Response:', response);
		
		// Transform AI response to our format
		const elements: DetectedElement[] = [];
		
		if (response && Array.isArray(response)) {
			for (const detection of response) {
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
		
		// If no objects detected, provide fallback
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
		console.error('AI detection failed, falling back to demo mode:', error);
		
		// Fallback to demo response if AI fails
		const dimensions = await getImageDimensions(imageBuffer);
		const elements = await createDemoResponse();
		
		const imageInfo = {
			width: dimensions.width,
			height: dimensions.height,
			format: 'image/png',
			size: imageBuffer.byteLength
		};
		
		return { elements, imageInfo };
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
			error: error.message || 'Failed to analyze image',
			timestamp: new Date().toISOString()
		} as APIResponse, { status: 500 });
	}
}

/**
 * Handle health check endpoint
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