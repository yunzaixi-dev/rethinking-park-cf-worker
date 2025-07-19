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
 * Create demo response for fast testing
 */
async function createDemoResponse(): Promise<DetectedElement[]> {
	console.log('Using demo mode for fast response...');
	
	// Return mock detection results instantly
	return [
		{
			type: 'tree',
			confidence: 0.85,
			description: 'Tree (Demo)',
			bbox: { x: 150, y: 100, width: 120, height: 180 }
		},
		{
			type: 'grass',
			confidence: 0.72,
			description: 'Grass (Demo)',
			bbox: { x: 50, y: 400, width: 300, height: 80 }
		},
		{
			type: 'sky',
			confidence: 0.91,
			description: 'Sky (Demo)',
			bbox: { x: 0, y: 0, width: 800, height: 200 }
		}
	];
}

/**
 * Analyze image using demo mode
 */
async function analyzeImageWithAI(imageBuffer: ArrayBuffer, env: Env): Promise<DetectedElement[]> {
	try {
		// For demo purposes, return instant results
		return await createDemoResponse();
	} catch (error) {
		console.error('Demo detection failed:', error);
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
						<p>Powered by Cloudflare Workers AI (Demo Mode)</p>
						
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

		// Add rate limit headers to successful responses
		response.headers.set('X-RateLimit-Limit', RATE_LIMIT_CONFIG.requests.toString());
		response.headers.set('X-RateLimit-Remaining', rateLimitResult.remaining.toString());
		response.headers.set('X-RateLimit-Reset', Math.ceil(rateLimitResult.resetTime / 1000).toString());
		
		return addCorsHeaders(response, request);
	},
} satisfies ExportedHandler<Env>;