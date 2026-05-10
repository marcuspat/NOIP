/**
 * Performance Load Tests
 * k6 load testing script for NOIP platform
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');

// Test configuration
export const options = {
  stages: [
    // Warm-up phase
    { duration: '2m', target: 10 },
    // Normal load
    { duration: '5m', target: 50 },
    // Peak load
    { duration: '2m', target: 100 },
    // Sustained peak
    { duration: '5m', target: 100 },
    // Scale down
    { duration: '2m', target: 50 },
    // Recovery
    { duration: '2m', target: 10 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests under 500ms
    http_req_failed: ['rate<0.01'], // Error rate below 1%
    errors: ['rate<0.01'], // Custom error rate below 1%
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export function setup() {
  console.log(`Starting load test against ${BASE_URL}`);

  // Verify the application is running
  const healthResponse = http.get(`${BASE_URL}/health`);
  check(healthResponse, {
    'health check passed': r => r.status === 200,
  });

  if (healthResponse.status !== 200) {
    throw new Error('Application health check failed');
  }
}

export default function () {
  // Test different endpoints
  const scenarios = [
    { weight: 40, endpoint: '/health' },
    { weight: 30, endpoint: '/api/discovery/cluster' },
    { weight: 20, endpoint: '/api/security/score' },
    { weight: 10, endpoint: '/api/dashboard' },
  ];

  // Select endpoint based on weights
  const random = Math.random() * 100;
  let cumulative = 0;
  let selectedEndpoint = '/health';

  for (const scenario of scenarios) {
    cumulative += scenario.weight;
    if (random <= cumulative) {
      selectedEndpoint = scenario.endpoint;
      break;
    }
  }

  // Make request
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'k6-load-test',
    },
  };

  const response = http.get(`${BASE_URL}${selectedEndpoint}`, params);

  // Check response
  const success = check(response, {
    'status is 200': r => r.status === 200,
    'response time < 500ms': r => r.timings.duration < 500,
    'response time < 1000ms': r => r.timings.duration < 1000,
    'response body not empty': r => r.body.length > 0,
  });

  errorRate.add(!success);

  // Add some think time
  sleep(Math.random() * 2 + 1);
}

export function teardown() {
  console.log('Load test completed');
}
