import { config } from '../src/config';

// Set test environment
process.env['NODE_ENV'] = 'test';

// Override config for testing
config.app.environment = 'test';
config.services.discovery.enabled = true;
config.services.security.enabled = true;
config.services.ai.enabled = false; // Disable AI for unit tests to avoid API calls
config.database.mongodb.uri = 'mongodb://localhost:27017/noip-test';
config.database.redis.db = 1; // Use different DB for tests

// Mock console methods in tests
global.console = {
  ...console,
  // Uncomment to ignore specific console methods during tests
  // log: jest.fn(),
  // debug: jest.fn(),
  // info: jest.fn(),
  // warn: jest.fn(),
  // error: jest.fn(),
};

// Set up global test timeout
jest.setTimeout(30000);