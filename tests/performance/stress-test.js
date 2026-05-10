/**
 * Stress Tests
 * k6 stress testing script for NOIP platform
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const activeUsers = new Rate('active_users');

// Test configuration
export const options = {
  stages: [
    // Ramp up to maximum load
    { duration: '1m', target: 50 },
    { duration: '1m', target: 100 },
    { duration: '1m', target: 200 },
    { duration: '1m', target: 500 },
    // Sustained maximum load
    { duration: '5m', target: 500 },
    // Peak stress
    { duration: '2m', target: 1000 },
    // Gradual recovery
    { duration: '2m', target: 500 },
    { duration: '2m', target: 200 },
    { duration: '2m', target: 50 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'], // More lenient during stress test
    http_req_failed: ['rate<0.05'], // Allow higher error rate during stress
    errors: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export function setup() {
  console.log(`Starting stress test against ${BASE_URL}`);

  // Verify the application is running
  const healthResponse = http.get(`${BASE_URL}/health`);
  check(healthResponse, {
    'health check passed': r => r.status === 200,
  });
}

export default function () {
  // Stress test with more demanding operations
  const endpoints = [
    '/health',
    '/api/discovery/cluster',
    '/api/discovery/namespaces',
    '/api/security/score',
    '/api/security/recommendations',
    '/api/dashboard',
  ];

  // Random endpoint selection
  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];

  // Make request with possible payload for POST endpoints
  let response;
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'k6-stress-test',
    },
  };

  if (endpoint.includes('security') && Math.random() > 0.5) {
    // Simulate POST requests for security endpoints
    const payload = JSON.stringify({
      resources: [
        { type: 'pod', name: 'test-pod' },
        { type: 'service', name: 'test-service' },
      ],
    });
    response = http.post(`${BASE_URL}${endpoint}`, payload, params);
  } else {
    response = http.get(`${BASE_URL}${endpoint}`, params);
  }

  // Check response with more lenient thresholds for stress test
  const success = check(response, {
    'status is 200': r => r.status === 200 || r.status === 429, // Allow rate limiting
    'response time < 2000ms': r => r.timings.duration < 2000,
    'response time < 5000ms': r => r.timings.duration < 5000,
  });

  errorRate.add(!success);
  activeUsers.add(1);

  // Minimal think time during stress test
  sleep(Math.random() * 0.5 + 0.1);
}

export function teardown() {
  console.log('Stress test completed');
}
