import request from 'supertest';
import app from '../../src/app';

describe('API Integration Tests', () => {
  describe('Health Endpoint', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health').expect(200);

      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('environment');
      expect(response.body).toHaveProperty('services');

      const services = response.body.services;
      expect(services).toHaveProperty('discovery');
      expect(services).toHaveProperty('security');
      expect(services).toHaveProperty('ai');
      expect(services).toHaveProperty('dashboard');
    });
  });

  describe('Discovery API', () => {
    it('should get cluster information', async () => {
      const response = await request(app)
        .get('/api/discovery/cluster')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('name');
      expect(response.body.data).toHaveProperty('version');
      expect(response.body.data).toHaveProperty('nodeCount');
      expect(response.body.data).toHaveProperty('podCount');
    });

    it('should get resources', async () => {
      const response = await request(app)
        .get('/api/discovery/resources')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should get namespaces', async () => {
      const response = await request(app)
        .get('/api/discovery/namespaces')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toContain('default');
    });

    it('should get node information', async () => {
      const response = await request(app)
        .get('/api/discovery/nodes')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('Security API', () => {
    it('should perform security scan', async () => {
      const response = await request(app)
        .post('/api/security/scan')
        .send({ resources: [{ kind: 'Pod', metadata: { name: 'test' } }] })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should get security score', async () => {
      const response = await request(app)
        .get('/api/security/score')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toHaveProperty('score');
      expect(typeof response.body.data.score).toBe('number');
    });

    it('should get security recommendations', async () => {
      const response = await request(app)
        .get('/api/security/recommendations')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should scan pod security', async () => {
      const response = await request(app)
        .get('/api/security/scan/pods')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should scan network policies', async () => {
      const response = await request(app)
        .get('/api/security/scan/network')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('AI API', () => {
    it('should analyze infrastructure', async () => {
      const response = await request(app)
        .post('/api/ai/analyze/infrastructure')
        .send({ data: { pods: 10, nodes: 3 } })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toHaveProperty('insights');
      expect(response.body.data).toHaveProperty('recommendations');
      expect(response.body.data).toHaveProperty('confidence');
      expect(response.body.data).toHaveProperty('timestamp');
    });

    it('should analyze security', async () => {
      const response = await request(app)
        .post('/api/ai/analyze/security')
        .send({ scanResults: [{ severity: 'high', category: 'RBAC' }] })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toHaveProperty('insights');
      expect(response.body.data).toHaveProperty('recommendations');
    });

    it('should analyze compliance', async () => {
      const response = await request(app)
        .post('/api/ai/analyze/compliance')
        .send({ resources: [{ kind: 'Deployment' }] })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toHaveProperty('insights');
      expect(response.body.data).toHaveProperty('recommendations');
    });
  });

  describe('Dashboard API', () => {
    it('should get all dashboards', async () => {
      const response = await request(app).get('/api/dashboard').expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should create a new dashboard', async () => {
      const dashboardData = {
        name: 'Test Dashboard',
        description: 'Test dashboard for integration testing',
        widgets: [],
        layout: 'grid',
        refreshInterval: 60000,
      };

      const response = await request(app)
        .post('/api/dashboard')
        .send(dashboardData)
        .expect(201);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data.name).toBe(dashboardData.name);
    });

    it('should get widget data', async () => {
      const response = await request(app)
        .get('/api/dashboard/widget/test-widget/data')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('data');
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 for unknown endpoints', async () => {
      const response = await request(app).get('/api/unknown').expect(404);

      expect(response.body).toHaveProperty('error', 'Endpoint not found');
      expect(response.body).toHaveProperty('path');
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should handle invalid JSON in request body', async () => {
      const response = await request(app)
        .post('/api/security/scan')
        .send('invalid json')
        .set('Content-Type', 'application/json')
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });

    it('should handle rate limiting', async () => {
      // Make multiple rapid requests to test rate limiting
      const promises = Array(10)
        .fill(null)
        .map(() => request(app).get('/health'));

      const responses = await Promise.all(promises);

      // At least one should succeed
      expect(responses.some(r => r.status === 200)).toBe(true);

      // Some might be rate limited depending on configuration
      const rateLimited = responses.some(r => r.status === 429);
      if (rateLimited) {
        const rateLimitedResponse = responses.find(r => r.status === 429);
        expect(rateLimitedResponse.body).toHaveProperty('error');
      }
    });
  });
});
