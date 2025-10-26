import { test, expect } from '@playwright/test';

test.describe('NOIP Platform E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the application
    await page.goto('http://localhost:3000');
  });

  test('should load main application page', async ({ page }) => {
    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Check if page loads successfully
    await expect(page).toHaveTitle(/NOIP Platform/);

    // Check for main navigation elements
    const nav = await page.locator('nav').first();
    await expect(nav).toBeVisible();

    // Check for main content area
    const main = await page.locator('main').first();
    await expect(main).toBeVisible();
  });

  test('should display health status', async ({ page }) => {
    // Navigate to health endpoint
    const response = await page.goto('/health');
    expect(response?.ok()).toBeTruthy();

    const content = await page.textContent('body');
    expect(content).toContain('healthy');
    expect(content).toContain('services');
  });

  test('should access discovery service', async ({ page }) => {
    // Navigate to discovery API
    const response = await page.goto('/api/discovery/cluster');
    expect(response?.ok()).toBeTruthy();

    const content = await page.textContent('body');
    expect(content).toContain('success');
    expect(content).toContain('data');
  });

  test('should access security service', async ({ page }) => {
    // Navigate to security score endpoint
    const response = await page.goto('/api/security/score');
    expect(response?.ok()).toBeTruthy();

    const content = await page.textContent('body');
    expect(content).toContain('success');
    expect(content).toContain('score');
  });

  test('should access dashboard service', async ({ page }) => {
    // Navigate to dashboard endpoint
    const response = await page.goto('/api/dashboard');
    expect(response?.ok()).toBeTruthy();

    const content = await page.textContent('body');
    expect(content).toContain('success');
    expect(content).toContain('data');
  });

  test('should handle error gracefully', async ({ page }) => {
    // Navigate to non-existent endpoint
    const response = await page.goto('/api/nonexistent');
    expect(response?.status()).toBe(404);

    const content = await page.textContent('body');
    expect(content).toContain('Endpoint not found');
  });

  test('should demonstrate real-time data updates', async ({ page }) => {
    // Navigate to dashboard
    await page.goto('/api/dashboard');

    // Get initial content
    const initialContent = await page.textContent('body');

    // Wait a moment and refresh
    await page.waitForTimeout(1000);
    await page.reload();

    // Get updated content
    const updatedContent = await page.textContent('body');

    // Both should be valid responses
    expect(initialContent).toContain('success');
    expect(updatedContent).toContain('success');
  });

  test('should handle concurrent requests', async ({ page }) => {
    // Make multiple concurrent requests
    const requests = [
      page.goto('/api/discovery/cluster'),
      page.goto('/api/security/score'),
      page.goto('/api/dashboard'),
      page.goto('/health'),
    ];

    const responses = await Promise.all(requests);

    // All requests should succeed
    responses.forEach(response => {
      expect(response?.ok()).toBeTruthy();
    });
  });

  test('should maintain session state', async ({ page }) => {
    // Navigate to multiple endpoints in sequence
    await page.goto('/health');
    await page.waitForTimeout(500);

    await page.goto('/api/discovery/cluster');
    await page.waitForTimeout(500);

    await page.goto('/api/security/score');
    await page.waitForTimeout(500);

    await page.goto('/api/dashboard');
    await page.waitForTimeout(500);

    // All should work without session issues
    const finalResponse = await page.goto('/health');
    expect(finalResponse?.ok()).toBeTruthy();
  });

  test('should handle large payloads', async ({ page }) => {
    // Create a large payload for AI analysis
    const largeData = {
      resources: Array(100).fill(null).map((_, i) => ({
        id: `resource-${i}`,
        type: 'Pod',
        namespace: `namespace-${i % 10}`,
        spec: {
          containers: [
            {
              name: 'container',
              image: 'nginx:latest',
              resources: {
                requests: {
                  cpu: '100m',
                  memory: '128Mi',
                },
                limits: {
                  cpu: '500m',
                  memory: '512Mi',
                },
              },
            },
          ],
        },
      })),
    };

    // Make POST request with large payload
    const response = await page.request.post('/api/ai/analyze/infrastructure', {
      data: largeData,
    });

    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.success).toBe(true);
  });

  test('should demonstrate security features', async ({ page }) => {
    // Check for security headers
    const response = await page.goto('/health');
    const headers = response?.headers();

    // Check for security-related headers
    expect(headers?.['x-content-type-options']).toBe('nosniff');
    expect(headers?.['x-frame-options']).toBeDefined();
    expect(headers?.['x-xss-protection']).toBeDefined();
  });

  test('should handle WebSocket connections (if implemented)', async ({ page }) => {
    // This test would be for real-time WebSocket functionality
    // For now, we'll test that the server handles WebSocket upgrade requests

    const response = await page.request.get('/health', {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
      },
    });

    // Should either accept WebSocket or return appropriate error
    expect([200, 400, 426]).toContain(response.status());
  });
});

test.describe('Performance Tests', () => {
  test('should respond quickly to health checks', async ({ page }) => {
    const startTime = Date.now();

    const response = await page.goto('/health');
    const endTime = Date.now();

    expect(response?.ok()).toBeTruthy();
    expect(endTime - startTime).toBeLessThan(1000); // Should respond within 1 second
  });

  test('should handle API requests efficiently', async ({ page }) => {
    const endpoints = [
      '/api/discovery/cluster',
      '/api/security/score',
      '/api/dashboard',
    ];

    for (const endpoint of endpoints) {
      const startTime = Date.now();

      const response = await page.goto(endpoint);
      const endTime = Date.now();

      expect(response?.ok()).toBeTruthy();
      expect(endTime - startTime).toBeLessThan(2000); // Should respond within 2 seconds
    }
  });
});