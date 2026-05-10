// Main entry point for the NOIP Platform
export { default as app } from './app';
export { startServer, initializeServices } from './app';

// Export services
export { DiscoveryService } from './services/discovery.service';
export { SecurityService } from './contexts/security/api';
export { AIService } from './contexts/ai/api';
export { DashboardService } from './services/dashboard.service';

// Export types
export * from './types';

// Export config
export { config } from './config';
