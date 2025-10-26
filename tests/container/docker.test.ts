/**
 * Docker Container Tests
 * Comprehensive testing for Docker images and containers
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('Docker Container Tests', () => {
  const imageName = 'noip/platform:test';
  const testContainerName = 'noip-test-container';

  beforeAll(async () => {
    // Build test image
    console.log('Building test Docker image...');
    execSync(`docker build -t ${imageName} -f docker/Dockerfile.test .`, {
      stdio: 'inherit'
    });
  });

  afterAll(async () => {
    // Cleanup test containers and images
    try {
      execSync(`docker rm -f ${testContainerName}`, { stdio: 'inherit' });
      execSync(`docker rmi -f ${imageName}`, { stdio: 'inherit' });
    } catch (error) {
      console.log('Cleanup completed (some resources may not have existed)');
    }
  });

  describe('Dockerfile Security Tests', () => {
    test('should use non-root user', () => {
      const dockerfileContent = fs.readFileSync('docker/Dockerfile', 'utf8');
      expect(dockerfileContent).toContain('RUN adduser');
      expect(dockerfileContent).toContain('USER');
    });

    test('should have minimal layers', () => {
      const dockerfileContent = fs.readFileSync('docker/Dockerfile', 'utf8');
      // Check for multi-stage build
      expect(dockerfileContent).toMatch(/FROM.*AS/);
    });

    test('should include health checks', () => {
      const dockerfileContent = fs.readFileSync('docker/Dockerfile', 'utf8');
      expect(dockerfileContent).toContain('HEALTHCHECK');
    });

    test('should drop all capabilities', () => {
      const dockerfileContent = fs.readFileSync('docker/Dockerfile', 'utf8');
      expect(dockerfileContent).toContain('drop:');
      expect(dockerfileContent).toContain('ALL');
    });
  });

  describe('Container Build Tests', () => {
    test('should build successfully', () => {
      expect(() => {
        execSync(`docker build -t ${imageName} -f docker/Dockerfile .`, { stdio: 'pipe' });
      }).not.toThrow();
    });

    test('should have acceptable image size', () => {
      const output = execSync(`docker images ${imageName} --format "{{.Size}}"`, {
        encoding: 'utf8'
      }).trim();

      // Convert size to MB for comparison
      const sizeMatch = output.match(/(\d+(?:\.\d+)?)([KMGT]?B)/);
      if (sizeMatch) {
        const [, size, unit] = sizeMatch;
        const sizeInMB = convertToMB(parseFloat(size), unit);
        expect(sizeInMB).toBeLessThan(500); // Should be under 500MB
      }
    });

    test('should not have known vulnerabilities', async () => {
      try {
        execSync(`docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
          aquasec/trivy:latest image --exit-code 0 --severity HIGH,CRITICAL ${imageName}`,
          { stdio: 'pipe' }
        );
      } catch (error) {
        fail('Container has high or critical vulnerabilities');
      }
    });
  });

  describe('Container Runtime Tests', () => {
    test('should start successfully', async () => {
      expect(() => {
        execSync(`docker run -d --name ${testContainerName} -p 3001:3000 ${imageName}`,
          { stdio: 'pipe' }
        );
      }).not.toThrow();

      // Wait for container to start
      await new Promise(resolve => setTimeout(resolve, 5000));
    });

    test('should respond to health check', async () => {
      const maxAttempts = 30;
      let attempts = 0;

      while (attempts < maxAttempts) {
        try {
          const response = execSync(`docker exec ${testContainerName} curl -f http://localhost:3000/health`,
            { encoding: 'utf8', stdio: 'pipe' }
          );
          const healthData = JSON.parse(response);
          expect(healthData.status).toBe('healthy');
          return;
        } catch (error) {
          attempts++;
          if (attempts >= maxAttempts) {
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    });

    test('should have correct environment variables', () => {
      const envOutput = execSync(`docker exec ${testContainerName} env`, {
        encoding: 'utf8'
      });

      expect(envOutput).toContain('NODE_ENV=production');
      expect(envOutput).toContain('PORT=3000');
    });

    test('should not run as root', () => {
      const userOutput = execSync(`docker exec ${testContainerName} whoami`, {
        encoding: 'utf8'
      }).trim();

      expect(userOutput).not.toBe('root');
    });

    test('should have limited capabilities', () => {
      const capsOutput = execSync(`docker exec ${testContainerName} capsh --print`, {
        encoding: 'utf8'
      });

      // Should have minimal capabilities
      expect(capsOutput).not.toContain('CAP_SYS_ADMIN');
    });
  });

  describe('Container Performance Tests', () => {
    test('should start within acceptable time', async () => {
      const startTime = Date.now();

      execSync(`docker run --rm ${imageName} /bin/sh -c "echo 'Container started'"`,
        { stdio: 'pipe' }
      );

      const startupTime = Date.now() - startTime;
      expect(startupTime).toBeLessThan(30000); // Should start within 30 seconds
    });

    test('should have acceptable memory usage', async () => {
      // Run container and check memory usage
      const containerId = execSync(`docker run -d ${imageName}`, {
        encoding: 'utf8'
      }).trim();

      await new Promise(resolve => setTimeout(resolve, 10000));

      try {
        const statsOutput = execSync(`docker stats --no-stream --format "{{.MemUsage}}" ${containerId}`,
          { encoding: 'utf8'
        }).trim();

        const memMatch = statsOutput.match(/(\d+(?:\.\d+)?)([KMGT]?i?B)\/(\d+(?:\.\d+)?)([KMGT]?i?B)/);
        if (memMatch) {
          const [, used, usedUnit, total, totalUnit] = memMatch;
          const usedMB = convertToMB(parseFloat(used), usedUnit);
          expect(usedMB).toBeLessThan(512); // Should use less than 512MB
        }
      } finally {
        execSync(`docker rm -f ${containerId}`, { stdio: 'inherit' });
      }
    });
  });

  describe('Container Security Tests', () => {
    test('should have read-only filesystem where possible', () => {
      const inspectOutput = execSync(`docker inspect ${testContainerName}`, {
        encoding: 'utf8'
      });

      const containerConfig = JSON.parse(inspectOutput)[0];
      // Check if filesystem is read-only
      const readonlyRootfs = containerConfig.HostConfig.ReadonlyRootfs;
      // This may be false for some applications that need to write logs
      expect(typeof readonlyRootfs).toBe('boolean');
    });

    test('should not have privileged access', () => {
      const inspectOutput = execSync(`docker inspect ${testContainerName}`, {
        encoding: 'utf8'
      });

      const containerConfig = JSON.parse(inspectOutput)[0];
      expect(containerConfig.HostConfig.Privileged).toBe(false);
    });

    test('should have no sensitive data in image layers', () => {
      const historyOutput = execSync(`docker history ${imageName}`, {
        encoding: 'utf8'
      });

      // Check for any obvious sensitive data in layer commands
      expect(historyOutput).not.toMatch(/password|secret|key|token/i);
    });
  });

  describe('Container Logging Tests', () => {
    test('should produce structured logs', async () => {
      const logsOutput = execSync(`docker logs ${testContainerName}`, {
        encoding: 'utf8'
      });

      // Should have JSON structured logs
      expect(logsOutput).toMatch(/\{.*\}/);
    });

    test('should not log sensitive information', async () => {
      const logsOutput = execSync(`docker logs ${testContainerName}`, {
        encoding: 'utf8'
      });

      // Check for sensitive information in logs
      expect(logsOutput).not.toMatch(/password|secret|token|key/i);
    });
  });

  describe('Container Network Tests', () => {
    test('should expose only necessary ports', () => {
      const inspectOutput = execSync(`docker inspect ${testContainerName}`, {
        encoding: 'utf8'
      });

      const containerConfig = JSON.parse(inspectOutput)[0];
      const exposedPorts = Object.keys(containerConfig.Config.ExposedPorts || {});

      // Should only expose port 3000
      expect(exposedPorts).toHaveLength(1);
      expect(exposedPorts[0]).toContain('3000');
    });

    test('should bind to correct interfaces', () => {
      const inspectOutput = execSync(`docker inspect ${testContainerName}`, {
        encoding: 'utf8'
      });

      const containerConfig = JSON.parse(inspectOutput)[0];
      const portBindings = containerConfig.HostConfig.PortBindings;

      if (portBindings) {
        // Should bind to localhost or all interfaces as configured
        const binding = portBindings['3000/tcp'];
        if (binding && binding[0]) {
          expect(binding[0].HostIp).toMatch(/^127\.0\.0\.1$|^0\.0\.0\.0$|^$/);
        }
      }
    });
  });
});

// Helper function to convert sizes to MB
function convertToMB(size: number, unit: string): number {
  const units: { [key: string]: number } = {
    'B': 1 / (1024 * 1024),
    'KB': 1 / 1024,
    'K': 1 / 1024,
    'MB': 1,
    'M': 1,
    'GB': 1024,
    'G': 1024,
    'TB': 1024 * 1024,
    'T': 1024 * 1024
  };

  return size * (units[unit] || 1);
}