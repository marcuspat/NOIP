# NOIP Platform Container Deployment Guide

## Overview

This comprehensive deployment guide covers the production-ready container deployment and Kubernetes orchestration for the NOIP platform. The implementation includes Docker containerization, Kubernetes orchestration, monitoring, security hardening, and comprehensive CI/CD integration.

## Architecture Summary

### Container Architecture
- **Multi-stage Docker builds** with security hardening
- **Production-optimized images** with minimal attack surface
- **Non-root execution** with least privilege principles
- **Health checks** and graceful shutdown handling
- **Security scanning** and vulnerability assessment

### Kubernetes Architecture
- **Production namespace** with resource quotas and security policies
- **Auto-scaling** with HPA and custom metrics
- **High availability** with multiple replicas and PDBs
- **Service mesh preparation** with Istio integration
- **Zero-trust networking** with micro-segmentation

### Database Architecture
- **MongoDB StatefulSet** with 3-node replica set
- **Redis cache** with persistence and high availability
- **Automated backups** and disaster recovery
- **Performance monitoring** with custom exporters
- **Security hardening** with authentication and encryption

### Monitoring & Observability
- **Prometheus** for metrics collection and alerting
- **Grafana** for visualization and dashboards
- **AlertManager** for intelligent alert routing
- **Custom dashboards** for application and infrastructure metrics
- **Log aggregation** and structured logging

## Prerequisites

### System Requirements
- **Kubernetes cluster** v1.24+ with RBAC enabled
- **Docker** v20.10+ or compatible container runtime
- **kubectl** configured for cluster access
- **Helm** v3.0+ (optional for service mesh)
- **Node requirements**: 4+ vCPUs, 16GB+ RAM, 100GB+ storage

### Required Tools
```bash
# Container tools
docker --version
kubectl version --client

# Optional: Service mesh
helm version

# Local development
npm --version
node --version
```

### Namespace and RBAC Setup
```bash
# Create namespaces (handled by deployment script)
kubectl create namespace noip-production
kubectl create namespace noip-staging
kubectl create namespace noip-monitoring

# Service accounts and permissions
kubectl apply -f k8s/security/
```

## Quick Start

### 1. Clone and Setup
```bash
git clone <repository-url>
cd noip
npm install
```

### 2. Configure Environment
```bash
# Copy configuration templates
cp k8s/secrets/secrets.yaml.example k8s/secrets/secrets.yaml
cp docker/docker-compose.prod.yml.example docker/docker-compose.prod.yml

# Update secrets and configuration
# Edit k8s/secrets/secrets.yaml with actual values
# Edit docker/docker-compose.prod.yml with environment variables
```

### 3. Deploy Infrastructure
```bash
# Production deployment
./scripts/deploy.sh

# Or for specific environments
ENVIRONMENT=staging ./scripts/deploy.sh
NAMESPACE=noip-staging ./scripts/deploy.sh
```

### 4. Verify Deployment
```bash
# Check pod status
kubectl get pods -n noip-production

# Check services
kubectl get svc -n noip-production

# Check application health
curl https://noip.company.com/health
```

## Detailed Deployment Steps

### 1. Container Image Build

#### Production Docker Image
```bash
# Build production image
docker build -t noip/platform:latest -f docker/Dockerfile .

# Tag with version
docker tag noip/platform:latest noip/platform:v1.0.0

# Security scan
trivy image noip/platform:latest

# Push to registry
docker push noip/platform:latest
```

#### Development Image
```bash
# Build development image
docker build -t noip/platform:dev -f docker/Dockerfile.dev .

# Run locally
docker-compose -f docker/docker-compose.yml up
```

### 2. Database Deployment

#### MongoDB Cluster
```bash
# Deploy MongoDB StatefulSet
kubectl apply -f k8s/database/mongodb-statefulset.yaml

# Wait for pods to be ready
kubectl wait --for=condition=Ready pod -l app=mongodb -n noip-production --timeout=600s

# Initialize replica set
kubectl apply -f k8s/database/mongodb-statefulset.yaml
```

#### Redis Cache
```bash
# Deploy Redis StatefulSet
kubectl apply -f k8s/database/redis-statefulset.yaml

# Wait for Redis to be ready
kubectl wait --for=condition=Ready pod -l app=redis -n noip-production --timeout=300s
```

### 3. Application Deployment

#### Deploy Application Services
```bash
# Deploy configuration and secrets
kubectl apply -f k8s/configmaps/
kubectl apply -f k8s/secrets/

# Deploy services
kubectl apply -f k8s/services/

# Deploy main application
kubectl apply -f k8s/deployments/
```

#### Monitor Deployment
```bash
# Check deployment status
kubectl rollout status deployment/noip-platform -n noip-production

# View pod logs
kubectl logs -f deployment/noip-platform -n noip-production

# Check resource usage
kubectl top pods -n noip-production
```

### 4. Monitoring Setup

#### Deploy Monitoring Stack
```bash
# Deploy Prometheus and Grafana
kubectl apply -f k8s/monitoring/

# Wait for monitoring to be ready
kubectl wait --for=condition=Available deployment/prometheus -n noip-monitoring --timeout=300s
kubectl wait --for=condition=Available deployment/grafana -n noip-monitoring --timeout=300s
```

#### Access Monitoring
```bash
# Port forward to access dashboards
kubectl port-forward -n noip-monitoring svc/grafana-service 3000:3000

# Grafana URL: http://localhost:3000
# Default credentials: admin/admin123
```

### 5. Ingress Configuration

#### Deploy Ingress
```bash
# Deploy ingress controllers and TLS
kubectl apply -f k8s/ingress/

# Wait for ingress to be ready
kubectl wait --for=condition=Ready ingress/noip-platform-ingress -n noip-production --timeout=300s
```

#### Certificate Management
```bash
# Install cert-manager (if not already installed)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.12.0/cert-manager.yaml

# Deploy certificate issuers
kubectl apply -f k8s/ingress/
```

## Configuration Management

### Environment Variables
Key environment variables for production:

```yaml
# Application
NODE_ENV=production
PORT=3000

# Database
MONGODB_URI=mongodb://user:pass@mongodb-service:27017/noip_prod
REDIS_URL=redis://redis-service:6379

# Security
JWT_SECRET=<strong-random-secret>
CORS_ORIGIN=https://noip.company.com

# Monitoring
METRICS_ENABLED=true
TRACING_ENABLED=true
```

### Secrets Management
Sensitive configuration stored in Kubernetes secrets:

```bash
# Create secrets from files
kubectl create secret generic noip-platform-secrets \
  --from-file=mongodb-uri=./secrets/mongodb-uri.txt \
  --from-file=redis-url=./secrets/redis-url.txt \
  --from-file=jwt-secret=./secrets/jwt-secret.txt \
  -n noip-production
```

### Configuration Maps
Application configuration in ConfigMaps:

```bash
# Apply configuration
kubectl apply -f k8s/configmaps/configmap.yaml

# Update configuration
kubectl edit configmap noip-platform-config -n noip-production
```

## Security Configuration

### Network Security
- **Network policies** restrict pod-to-pod communication
- **Zero-trust networking** with micro-segmentation
- **TLS encryption** for all external traffic
- **API rate limiting** and DDoS protection

### Container Security
- **Non-root execution** with minimal privileges
- **Read-only filesystem** where possible
- **Security context** enforcement
- **Vulnerability scanning** in CI/CD pipeline

### RBAC Configuration
- **Service accounts** with least privilege
- **Role-based access** to Kubernetes resources
- **Pod security policies** enforcement
- **Audit logging** for all operations

## Monitoring and Alerting

### Key Metrics
- **Application metrics**: Request rate, response time, error rate
- **Infrastructure metrics**: CPU, memory, disk, network
- **Database metrics**: Connections, query performance, replication lag
- **Security metrics**: Authentication failures, unusual access patterns

### Alerting Rules
Critical alerts configured:
- **Application downtime**: Health check failures
- **High error rates**: 5xx responses > 1%
- **Performance degradation**: Response time > 1s
- **Resource exhaustion**: CPU/Memory > 90%
- **Database issues**: Replication lag, connection failures

### Dashboard Access
- **Grafana**: https://grafana.noip.company.com
- **Prometheus**: Internal access only
- **Application metrics**: `/metrics` endpoint

## Scaling and Performance

### Auto-Scaling Configuration
```yaml
# Horizontal Pod Autoscaler
minReplicas: 3
maxReplicas: 10
metrics:
- type: Resource
  resource:
    name: cpu
    target:
      type: Utilization
      averageUtilization: 70
- type: Resource
  resource:
    name: memory
    target:
      type: Utilization
      averageUtilization: 80
```

### Performance Tuning
- **Connection pooling** for database connections
- **Caching strategies** with Redis
- **CDN integration** for static assets
- **Load balancing** across multiple instances

## Backup and Recovery

### Database Backups
```bash
# MongoDB backup
kubectl exec -it mongodb-0 -n noip-production -- mongodump --out /backup/$(date +%Y%m%d)

# Redis backup
kubectl exec -it redis-0 -n noip-production -- redis-cli BGSAVE
```

### Disaster Recovery
- **Automated backup** schedules
- **Multi-region replication** for critical data
- **Point-in-time recovery** capabilities
- **Recovery procedures** documented and tested

## Troubleshooting

### Common Issues

#### Application Not Starting
```bash
# Check pod status
kubectl get pods -n noip-production

# View pod logs
kubectl logs -f <pod-name> -n noip-production

# Describe pod for detailed information
kubectl describe pod <pod-name> -n noip-production
```

#### Database Connection Issues
```bash
# Check database pods
kubectl get pods -l app=mongodb -n noip-production
kubectl get pods -l app=redis -n noip-production

# Test database connectivity
kubectl exec -it <pod-name> -n noip-production -- ping mongodb-service
```

#### Performance Issues
```bash
# Check resource usage
kubectl top pods -n noip-production
kubectl top nodes

# View metrics
kubectl exec -it prometheus-<pod> -n noip-monitoring -- promtool query instant 'up{job="noip-platform"}'
```

#### Ingress Issues
```bash
# Check ingress status
kubectl get ingress -n noip-production

# View ingress logs
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller
```

### Debug Commands
```bash
# Port forward for local debugging
kubectl port-forward -n noip-production svc/noip-platform-service 8080:80

# Execute shell in container
kubectl exec -it <pod-name> -n noip-production -- /bin/sh

# Resource usage analysis
kubectl describe node <node-name>
```

## Maintenance Operations

### Rolling Updates
```bash
# Update deployment with new image
kubectl set image deployment/noip-platform noip-platform=noip/platform:v1.1.0 -n noip-production

# Monitor update progress
kubectl rollout status deployment/noip-platform -n noip-production

# Rollback if needed
kubectl rollout undo deployment/noip-platform -n noip-production
```

### Certificate Rotation
```bash
# Certificate renewal handled automatically by cert-manager
# Manual renewal if needed:
kubectl get certificate -n noip-production
kubectl describe certificate noip-platform-cert -n noip-production
```

### Resource Scaling
```bash
# Scale deployment manually
kubectl scale deployment noip-platform --replicas=5 -n noip-production

# Update resource limits
kubectl patch deployment noip-platform -p '{"spec":{"template":{"spec":{"containers":[{"name":"noip-platform","resources":{"limits":{"cpu":"1000m","memory":"1Gi"}}}]}}}}' -n noip-production
```

## Testing

### Local Testing
```bash
# Run Docker Compose for local development
docker-compose -f docker/docker-compose.yml up

# Run tests
npm run test
npm run test:integration
npm run test:e2e
```

### Load Testing
```bash
# Install k6
curl https://github.com/grafana/k6/releases/download/v0.45.0/k6-v0.45.0-linux-amd64.tar.gz -L | tar xvz
sudo mv k6-v0.45.0-linux-amd64/k6 /usr/local/bin/

# Run load tests
k6 run tests/performance/load-test.js

# Run stress tests
k6 run tests/performance/stress-test.js
```

### Security Testing
```bash
# Run container security scan
trivy image noip/platform:latest

# Run Kubernetes security tests
npm run test:security
```

## Best Practices

### Security
- **Regular security scans** in CI/CD pipeline
- **Least privilege access** for all resources
- **Secrets management** with proper encryption
- **Regular updates** to base images and dependencies
- **Security monitoring** and alerting

### Performance
- **Resource limits** properly configured
- **Auto-scaling** based on metrics
- **Caching** for frequently accessed data
- **Database optimization** with proper indexing
- **Monitoring** of all critical metrics

### Reliability
- **High availability** with multiple replicas
- **Health checks** for all services
- **Graceful shutdown** handling
- **Backup strategies** tested regularly
- **Disaster recovery** procedures documented

### Maintainability
- **Infrastructure as code** with version control
- **Automated deployments** with rollback capability
- **Comprehensive monitoring** and logging
- **Documentation** kept up-to-date
- **Regular testing** of all components

## Support and Contact

### Documentation
- **Technical documentation**: `/docs/`
- **API documentation**: `/docs/api/`
- **Architecture diagrams**: `/docs/architecture/`

### Support Channels
- **Issues**: GitHub Issues
- **Emergencies**: ops-team@company.com
- **General inquiries**: noip-team@company.com

### Escalation Procedures
1. **Level 1**: Check this documentation and known issues
2. **Level 2**: Contact development team via Slack
3. **Level 3**: Escalate to ops team for critical issues
4. **Level 4**: Emergency contact for production outages

---

This deployment guide provides comprehensive instructions for deploying the NOIP platform in production environments with enterprise-grade security, scalability, and reliability.