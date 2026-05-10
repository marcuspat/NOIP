// Main entry point for the NOIP Platform
export { default as app } from './app';
export { startServer, initializeServices } from './app';

// Export services
export { DiscoveryService } from './services/discovery.service';
export { SecurityService } from './services/security.service';
export { AIService } from './services/ai.service';
export { DashboardService } from './services/dashboard.service';

// Export types
export * from './types';

// Export config
export { config } from './config';
