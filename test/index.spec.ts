import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('ReThinking Park API Worker', () => {
	describe('Health Check', () => {
		it('GET /api/v1/health returns healthy status', async () => {
			const request = new Request('http://example.com/api/v1/health');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			
			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toHaveProperty('status', 'healthy');
			expect(data).toHaveProperty('service', 'ReThinking Park Cloudflare Worker');
		});
	});

	describe('Root endpoint', () => {
		it('GET / returns HTML documentation', async () => {
			const request = new Request('http://example.com/');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			
			expect(response.status).toBe(200);
			expect(response.headers.get('Content-Type')).toBe('text/html');
			const html = await response.text();
			expect(html).toContain('ReThinking Park API');
		});
	});

	describe('Image Analysis', () => {
		it('POST /api/v1/analyze requires image file', async () => {
			const formData = new FormData();
			const request = new Request('http://example.com/api/v1/analyze', {
				method: 'POST',
				body: formData
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			
			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.success).toBe(false);
			expect(data.error).toBe('No image file provided');
		});

		it('POST /api/v1/analyze validates file type', async () => {
			const formData = new FormData();
			const textFile = new File(['test'], 'test.txt', { type: 'text/plain' });
			formData.append('image', textFile);
			
			const request = new Request('http://example.com/api/v1/analyze', {
				method: 'POST',
				body: formData
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			
			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.success).toBe(false);
			expect(data.error).toContain('Invalid image format');
		});
	});

	describe('404 handling', () => {
		it('returns 404 for unknown endpoints', async () => {
			const request = new Request('http://example.com/unknown');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			
			expect(response.status).toBe(404);
			const data = await response.json();
			expect(data.success).toBe(false);
			expect(data.error).toBe('Not Found');
		});
	});
});
