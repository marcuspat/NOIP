# NOIP Platform Operational Runbooks

## Overview

This document contains comprehensive operational runbooks for managing the NetOps Intelligence Platform (NOIP) in production environments. These runbooks provide step-by-step procedures for common operational tasks, incident response, and maintenance activities.

## Table of Contents

1. [Emergency Procedures](#emergency-procedures)
2. [Daily Operations](#daily-operations)
3. [Weekly Maintenance](#weekly-maintenance)
4. [Monthly Tasks](#monthly-tasks)
5. [Incident Response](#incident-response)
6. [Performance Troubleshooting](#performance-troubleshooting)
7. [Security Incidents](#security-incidents)
8. [Backup and Recovery](#backup-and-recovery)
9. [Scaling Operations](#scaling-operations)
10. [Compliance Management](#compliance-management)

---

## Emergency Procedures

### Service Outage Response

**Severity**: Critical
**Response Time**: < 5 minutes
**Escalation**: Immediate to Platform Lead

#### Step 1: Initial Assessment (0-5 minutes)

```bash
# Check service status
kubectl get pods -n noip-production
kubectl get services -n noip-production
kubectl get ingress -n noip-production

# Check health endpoints
curl -f https://api.noip.yourdomain.com/health

# Check error rates
kubectl logs -n noip-production -l app=noip-api --tail=100 | grep ERROR

# Check resource utilization
kubectl top pods -n noip-production
```

#### Step 2: Identify Root Cause (5-15 minutes)

```bash
# Check recent deployments
kubectl rollout history deployment/noip-api -n noip-production

# Check events
kubectl get events -n noip-production --sort-by=.metadata.creationTimestamp

# Check external dependencies
kubectl exec -it <pod-name> -n noip-production -- nslookup mongodb.noip-production.svc.cluster.local

# Check database connectivity
kubectl exec -it <pod-name> -n noip-production -- nc -zv mongodb 27017
```

#### Step 3: Immediate Mitigation (15-30 minutes)

```bash
# Restart affected pods
kubectl rollout restart deployment/noip-api -n noip-production

# Scale up if needed
kubectl scale deployment noip-api --replicas=5 -n noip-production

# Rollback if recent deployment caused issue
kubectl rollout undo deployment/noip-api -n noip-production

# Check rollout status
kubectl rollout status deployment/noip-api -n noip-production
```

#### Step 4: Communication (Ongoing)

```bash
# Update status page
curl -X POST https://status.noip.yourdomain.com/api/update \
  -H "Content-Type: application/json" \
  -d '{"status": "investigating", "message": "Service outage detected"}'

# Notify team via Slack
curl -X POST $SLACK_WEBHOOK \
  -H 'Content-type: application/json' \
  --data '{"text": "🚨 NOIP Platform Service Outage - Investigating"}'
```

### Database Failure Response

**Severity**: Critical
**Response Time**: < 10 minutes

#### Step 1: Assess Database Status

```bash
# MongoDB status check
kubectl exec -it mongodb-0 -n noip-production -- mongo --eval "db.adminCommand('ismaster')"

# Check MongoDB replica set
kubectl exec -it mongodb-0 -n noip-production -- mongo --eval "rs.status()"

# Redis status check
kubectl exec -it redis-master-0 -n noip-production -- redis-cli ping

# Check database logs
kubectl logs mongodb-0 -n noip-production --tail=50
```

#### Step 2: Database Recovery

```bash
# Restart MongoDB primary
kubectl delete pod mongodb-0 -n noip-production

# Wait for pod restart and replica set reformation
kubectl wait --for=condition=ready pod -l app=mongodb -n noip-production --timeout=300s

# Verify replica set status
kubectl exec -it mongodb-0 -n noip-production -- mongo --eval "rs.status()"

# Restart Redis if needed
kubectl delete pod redis-master-0 -n noip-production
```

#### Step 3: Application Recovery

```bash
# Restart application pods
kubectl rollout restart deployment/noip-api -n noip-production

# Check application connectivity to databases
kubectl logs -n noip-production -l app=noip-api --tail=20

# Verify health checks
curl -f https://api.noip.yourdomain.com/health
```

---

## Daily Operations

### Morning Health Check (Time: 08:00 UTC)

#### System Health Verification

```bash
#!/bin/bash
# daily-health-check.sh

echo "=== NOIP Platform Daily Health Check ==="
echo "Date: $(date)"
echo ""

# Check cluster health
echo "1. Cluster Status:"
kubectl cluster-info

# Check pod status
echo ""
echo "2. Pod Status:"
kubectl get pods -n noip-production

# Check service status
echo ""
echo "3. Service Status:"
kubectl get services -n noip-production

# Check ingress status
echo ""
echo "4. Ingress Status:"
kubectl get ingress -n noip-production

# Check resource usage
echo ""
echo "5. Resource Usage:"
kubectl top pods -n noip-production

# Check recent errors
echo ""
echo "6. Recent Errors:"
kubectl logs -n noip-production -l app=noip-api --since=24h | grep ERROR | tail -10

# Health endpoint check
echo ""
echo "7. API Health Check:"
curl -s https://api.noip.yourdomain.com/health | jq .

echo ""
echo "=== Health Check Complete ==="
```

#### Log Review

```bash
# Check application logs for errors
kubectl logs -n noip-production -l app=noip-api --since=24h | grep -E "(ERROR|WARN)" | tail -20

# Check database logs
kubectl logs mongodb-0 -n noip-production --since=24h | grep -E "(ERROR|WARN)" | tail -10

# Check Redis logs
kubectl logs redis-master-0 -n noip-production --since=24h | grep -E "(ERROR|WARN)" | tail -10
```

#### Performance Metrics Review

```bash
# Check CPU and memory usage
kubectl top nodes
kubectl top pods -n noip-production

# Check API response times
curl -s -o /dev/null -w "%{time_total}\n" https://api.noip.yourdomain.com/health

# Check database performance
kubectl exec -it mongodb-0 -n noip-production -- mongo --eval "db.runCommand({serverStatus: 1}).connections"
```

### Evening Backup Verification (Time: 20:00 UTC)

```bash
#!/bin/bash
# backup-verification.sh

echo "=== NOIP Platform Backup Verification ==="
echo "Date: $(date)"
echo ""

# Check MongoDB backups
echo "1. MongoDB Backup Status:"
kubectl get cronjobs -n noip-production | grep mongodb-backup

# Check last backup completion
kubectl get jobs -n noip-production --sort-by=.metadata.creationTimestamp | tail -5

# Verify backup integrity
echo ""
echo "2. Backup Integrity Check:"
# Add your backup integrity verification logic here

# Check storage usage
echo ""
echo "3. Storage Usage:"
df -h

# Check compliance evidence backup
echo ""
echo "4. Compliance Evidence Backup:"
kubectl get pvc -n noip-production | grep compliance

echo ""
echo "=== Backup Verification Complete ==="
```

---

## Weekly Maintenance

### Security Patching (Every Tuesday 02:00 UTC)

#### Step 1: Vulnerability Scan

```bash
# Scan images for vulnerabilities
trivy image noip/platform:1.0.0

# Scan running pods
kubectl get pods -n noip-production -o json | kubectl scan -

# Generate vulnerability report
trivy image --format json --output vulnerability-report.json noip/platform:1.0.0
```

#### Step 2: Patch Application

```bash
# Build new image with security patches
docker build -t noip/platform:1.0.1 .

# Push to registry
docker push noip/platform:1.0.1

# Update deployment
kubectl set image deployment/noip-api noip-api=noip/platform:1.0.1 -n noip-production

# Monitor rollout
kubectl rollout status deployment/noip-api -n noip-production
```

#### Step 3: Verify Patching

```bash
# Verify new version is running
kubectl get pods -n noip-production -l app=noip-api -o jsonpath='{.items[*].spec.containers[*].image}'

# Run smoke tests
npm run test:smoke

# Verify security controls
curl -s https://api.noip.yourdomain.com/api/security/scan
```

### Performance Optimization (Every Friday 18:00 UTC)

#### Step 1: Performance Analysis

```bash
# Generate performance report
curl -X POST https://api.noip.yourdomain.com/api/performance/summary \
  -H "Content-Type: application/json" \
  -d '{"timeframe": "7d"}' > performance-report.json

# Analyze bottlenecks
curl -X POST https://api.noip.yourdomain.com/api/performance/load-test/light

# Check resource utilization trends
kubectl top pods -n noip-production --sort-by=cpu
```

#### Step 2: Optimization Actions

```bash
# Update resource limits if needed
kubectl patch deployment noip-api -n noip-production -p '{"spec":{"template":{"spec":{"containers":[{"name":"noip-api","resources":{"limits":{"cpu":"1500m","memory":"3Gi"}}}]}}}}'

# Restart services to apply optimizations
kubectl rollout restart deployment/noip-api -n noip-production

# Update HPA thresholds if needed
kubectl patch hpa noip-api-hpa -n noip-production -p '{"spec":{"metrics":[{"resource":{"name":"cpu","target":{"averageUtilization":75}}}]}}'
```

#### Step 3: Validation

```bash
# Run load test to verify improvements
npm run test:load

# Check response times after optimization
curl -s -o /dev/null -w "%{time_total}\n" https://api.noip.yourdomain.com/health

# Verify error rates remain low
curl -s https://api.noip.yourdomain.com/api/performance/metrics | jq '.errorRate'
```

---

## Monthly Tasks

### Compliance Assessment (First Monday of Month)

```bash
#!/bin/bash
# monthly-compliance-assessment.sh

echo "=== Monthly Compliance Assessment ==="
echo "Date: $(date)"
echo ""

# Run SOC2 Type II assessment
echo "1. SOC2 Type II Assessment:"
curl -X POST https://api.noip.yourdomain.com/api/compliance/assessment/soc2-type2 \
  -H "Content-Type: application/json" > soc2-assessment.json

# Run ISO27001 assessment
echo ""
echo "2. ISO27001 Assessment:"
curl -X POST https://api.noip.yourdomain.com/api/compliance/assessment/iso27001 \
  -H "Content-Type: application/json" > iso27001-assessment.json

# Generate compliance reports
echo ""
echo "3. Generating Compliance Reports:"
curl -X GET "https://api.noip.yourdomain.com/api/compliance/report/soc2-type2/export?format=pdf" \
  -o compliance-reports/soc2-report-$(date +%Y%m).pdf

curl -X GET "https://api.noip.yourdomain.com/api/compliance/report/iso27001/export?format=pdf" \
  -o compliance-reports/iso27001-report-$(date +%Y%m).pdf

# Review critical findings
echo ""
echo "4. Critical Compliance Findings:"
curl -s https://api.noip.yourdomain.com/api/compliance/dashboard | jq '.alerts[] | select(.severity == "critical")'

echo ""
echo "=== Monthly Compliance Assessment Complete ==="
```

### Capacity Planning Review (Last Friday of Month)

```bash
#!/bin/bash
# capacity-planning-review.sh

echo "=== Monthly Capacity Planning Review ==="
echo "Date: $(date)"
echo ""

# Analyze current resource usage
echo "1. Current Resource Usage:"
kubectl top nodes
echo ""
kubectl top pods -n noip-production

# Analyze growth trends
echo ""
echo "2. Growth Trends Analysis:"
# Add your growth trend analysis logic here

# Review HPA performance
echo ""
echo "3. HPA Performance Review:"
kubectl describe hpa noip-api-hpa -n noip-production

# Generate capacity recommendations
echo ""
echo "4. Capacity Recommendations:"
curl -X POST https://api.noip.yourdomain.com/api/performance/summary \
  -H "Content-Type: application/json" \
  -d '{"timeframe": "30d"}' | jq '.recommendations'

echo ""
echo "=== Capacity Planning Review Complete ==="
```

---

## Incident Response

### P1 - Critical Incident Response

#### Incident Classification

**P1 Criteria:**
- Service completely unavailable
- >50% error rate
- Data loss or corruption
- Security breach
- Compliance violation

#### Response Timeline

- **0-5 minutes**: Incident acknowledgment
- **5-15 minutes**: Initial assessment
- **15-30 minutes**: Mitigation actions
- **30-60 minutes**: Root cause analysis
- **60+ minutes**: Resolution and recovery

#### Incident Command System

```bash
#!/bin/bash
# incident-response-p1.sh

INCIDENT_ID="INC-$(date +%Y%m%d-%H%M%S)"
echo "P1 Incident Response: $INCIDENT_ID"

# Create incident channel
curl -X POST $SLACK_WEBHOOK \
  -H 'Content-type: application/json' \
  --data "{\"text\": \"🚨 P1 INCIDENT DECLARED: $INCIDENT_ID\\nChannel: #incident-$INCIDENT_ID\"}"

# Escalate to leadership
curl -X POST $LEADERSHIP_WEBHOOK \
  -H 'Content-type: application/json' \
  --data "{\"text\": \"🚨 P1 INCIDENT: $INCIDENT_ID\\nImmediate attention required\"}"

# Start incident logging
echo "[$(date)] P1 Incident $INCIDENT_ID declared" >> /var/log/noip-incidents.log
```

### P2 - High Priority Incident Response

#### Incident Classification

**P2 Criteria:**
- Service degraded performance
- 10-50% error rate
- Partial feature unavailability
- Security concerns without breach
- Compliance risks

#### Response Timeline

- **0-15 minutes**: Incident acknowledgment
- **15-60 minutes**: Assessment and mitigation
- **1-4 hours**: Root cause analysis
- **4-8 hours**: Resolution

### P3 - Medium Priority Incident Response

#### Incident Classification

**P3 Criteria:**
- Minor performance degradation
- <10% error rate
- Documentation issues
- Non-critical feature problems

#### Response Timeline

- **0-1 hour**: Incident acknowledgment
- **1-8 hours**: Assessment and resolution
- **8-24 hours**: Root cause analysis

---

## Performance Troubleshooting

### High Response Time Investigation

#### Step 1: Identify Bottleneck

```bash
# Check application response times
curl -s -o /dev/null -w "%{time_total}\n" https://api.noip.yourdomain.com/api/test

# Check database query performance
kubectl exec -it mongodb-0 -n noip-production -- mongo --eval "db.runCommand({profile: 1})"

# Check resource utilization
kubectl top pods -n noip-production --sort-by=cpu
kubectl top pods -n noip-production --sort-by=memory
```

#### Step 2: Database Optimization

```bash
# Check slow queries
kubectl exec -it mongodb-0 -n noip-production -- mongo --eval "db.setProfilingLevel(2, {slowms: 100})"

# Analyze query performance
kubectl exec -it mongodb-0 -n noip-production -- mongo --eval "db.system.profile.find().limit(10).sort({ts: -1})"

# Check Redis performance
kubectl exec -it redis-master-0 -n noip-production -- redis-cli info stats
```

#### Step 3: Application Optimization

```bash
# Scale up resources temporarily
kubectl scale deployment noip-api --replicas=5 -n noip-production

# Check for memory leaks
kubectl exec -it <pod-name> -n noip-production -- ps aux

# Restart application to clear memory
kubectl rollout restart deployment/noip-api -n noip-production
```

### Memory Usage Investigation

#### Step 1: Memory Analysis

```bash
# Check pod memory usage
kubectl top pods -n noip-production --sort-by=memory

# Check for memory leaks in application
kubectl exec -it <pod-name> -n noip-production -- cat /proc/meminfo

# Check garbage collection
kubectl logs -n noip-production -l app=noip-api --since=1h | grep -i "gc\|memory"
```

#### Step 2: Memory Optimization

```bash
# Update memory limits
kubectl patch deployment noip-api -n noip-production -p '{"spec":{"template":{"spec":{"containers":[{"name":"noip-api","resources":{"limits":{"memory":"4Gi"}}}]}}}}'

# Add memory pressure monitoring
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: memory-monitor
  namespace: noip-production
spec:
  containers:
  - name: memory-monitor
    image: busybox
    command: ['sh', '-c', 'while true; do cat /proc/meminfo | grep MemAvailable; sleep 30; done']
EOF
```

---

## Security Incidents

### Unauthorized Access Detection

#### Step 1: Incident Assessment

```bash
# Check authentication logs
kubectl logs -n noip-production -l app=noip-api --since=24h | grep -i "auth\|login\|unauthorized"

# Check for unusual IP addresses
kubectl logs -n noip-production -l app=noip-api --since=24h | grep -E "ERROR|WARN" | grep -oE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" | sort | uniq -c | sort -nr

# Check RBAC violations
kubectl auth can-i --list --as=system:serviceaccount:noip-production:default -n noip-production
```

#### Step 2: Containment

```bash
# Revoke compromised tokens
kubectl delete secrets -n noip-production | grep token

# Rotate API keys
kubectl patch secret noip-secrets -n noip-production -p '{"data":{"claude-api-key":"<new-key>"}}'

# Enable additional logging
kubectl patch deployment noip-api -n noip-production -p '{"spec":{"template":{"spec":{"containers":[{"name":"noip-api","env":[{"name":"LOG_LEVEL","value":"debug"}]}]}}}}'
```

#### Step 3: Investigation

```bash
# Export audit logs
kubectl logs -n noip-production -l app=noip-api --since=72h > security-investigation.log

# Check network policies
kubectl get networkpolicies -n noip-production

# Review pod security contexts
kubectl get pods -n noip-production -o jsonpath='{.items[*].spec.securityContext}'
```

### Data Breach Response

#### Step 1: Assessment

```bash
# Check data access logs
kubectl logs -n noip-production -l app=noip-api --since=72h | grep -i "data\|export\|download"

# Check database access
kubectl exec -it mongodb-0 -n noip-production -- mongo --eval "db.runCommand({connectionStatus: 1})"

# Verify encryption status
kubectl exec -it <pod-name> -n noip-production -- env | grep -i encrypt
```

#### Step 2: Containment

```bash
# Isolate affected systems
kubectl patch deployment noip-api -n noip-production -p '{"spec":{"replicas":0}}'

# Backup current state
kubectl get all -n noip-production -o yaml > emergency-backup-$(date +%Y%m%d-%H%M%S).yaml

# Enable additional monitoring
kubectl apply -f security-enhancements.yaml
```

#### Step 3: Recovery

```bash
# Restore from backup if needed
kubectl apply -f emergency-backup-<timestamp>.yaml

# Rotate all secrets
kubectl delete secrets --all -n noip-production
kubectl apply -f secrets.yaml

# Gradually restore service
kubectl scale deployment noip-api --replicas=1 -n noip-production
```

---

## Backup and Recovery

### Database Backup Procedures

#### MongoDB Backup

```bash
#!/bin/bash
# mongodb-backup.sh

BACKUP_DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/backups/mongodb/$BACKUP_DATE"

echo "Starting MongoDB backup: $BACKUP_DATE"

# Create backup directory
mkdir -p $BACKUP_DIR

# Perform backup
kubectl exec -it mongodb-0 -n noip-production -- mongodump --out /tmp/backup

# Copy backup to persistent storage
kubectl cp mongodb-0:/tmp/backup $BACKUP_DIR

# Compress backup
tar -czf $BACKUP_DIR.tar.gz $BACKUP_DIR
rm -rf $BACKUP_DIR

# Verify backup
echo "Backup created: $BACKUP_DIR.tar.gz"
ls -lh $BACKUP_DIR.tar.gz

# Clean up old backups (keep 30 days)
find /backups/mongodb -name "*.tar.gz" -mtime +30 -delete

echo "MongoDB backup completed successfully"
```

#### Redis Backup

```bash
#!/bin/bash
# redis-backup.sh

BACKUP_DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/backups/redis/$BACKUP_DATE"

echo "Starting Redis backup: $BACKUP_DATE"

# Create backup directory
mkdir -p $BACKUP_DIR

# Trigger Redis backup
kubectl exec -it redis-master-0 -n noip-production -- redis-cli BGSAVE

# Wait for backup completion
sleep 30

# Copy backup file
kubectl cp redis-master-0:/data/dump.rdb $BACKUP_DIR/

# Verify backup
echo "Backup created: $BACKUP_DIR/dump.rdb"
ls -lh $BACKUP_DIR/dump.rdb

# Clean up old backups
find /backups/redis -name "dump.rdb" -mtime +7 -delete

echo "Redis backup completed successfully"
```

### Recovery Procedures

#### MongoDB Recovery

```bash
#!/bin/bash
# mongodb-recovery.sh

BACKUP_FILE=$1
RECOVERY_DATE=$(date +%Y%m%d-%H%M%S)

if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: $0 <backup-file.tar.gz>"
    exit 1
fi

echo "Starting MongoDB recovery from: $BACKUP_FILE"

# Extract backup
tar -xzf $BACKUP_FILE -C /tmp/recovery-$RECOVERY_DATE

# Stop MongoDB
kubectl scale deployment mongodb --replicas=0 -n noip-production

# Wait for pods to terminate
kubectl wait --for=delete pod -l app=mongodb -n noip-production --timeout=300s

# Restore data
kubectl cp /tmp/recovery-$RECOVERY_DATE/backup mongodb-0:/tmp/restore

# Start MongoDB
kubectl scale deployment mongodb --replicas=1 -n noip-production

# Wait for MongoDB to be ready
kubectl wait --for=condition=ready pod -l app=mongodb -n noip-production --timeout=300s

# Restore data
kubectl exec -it mongodb-0 -n noip-production -- mongorestore --drop /tmp/restore

# Verify recovery
kubectl exec -it mongodb-0 -n noip-production -- mongo --eval "db.adminCommand('listCollections')"

echo "MongoDB recovery completed successfully"
```

#### Application Recovery

```bash
#!/bin/bash
# application-recovery.sh

echo "Starting application recovery..."

# Check deployment status
kubectl get deployment -n noip-production

# Rollback to previous version if needed
kubectl rollout undo deployment/noip-api -n noip-production

# Wait for rollout to complete
kubectl rollout status deployment/noip-api -n noip-production --timeout=600s

# Verify health
curl -f https://api.noip.yourdomain.com/health

# Run smoke tests
npm run test:smoke

echo "Application recovery completed successfully"
```

---

## Scaling Operations

### Horizontal Scaling

#### Scale Up for High Load

```bash
#!/bin/bash
# scale-up.sh

REPLICAS=$1

if [ -z "$REPLICAS" ]; then
    REPLICAS=5
fi

echo "Scaling up to $REPLICAS replicas"

# Scale deployment
kubectl scale deployment noip-api --replicas=$REPLICAS -n noip-production

# Wait for new pods to be ready
kubectl wait --for=condition=ready pod -l app=noip-api -n noip-production --timeout=300s

# Verify scaling
kubectl get pods -n noip-production -l app=noip-api

# Update HPA if needed
kubectl patch hpa noip-api-hpa -n noip-production -p "{\"spec\":{\"minReplicas\":$REPLICAS}}"

echo "Scale up completed successfully"
```

#### Scale Down for Cost Optimization

```bash
#!/bin/bash
# scale-down.sh

REPLICAS=$1

if [ -z "$REPLICAS" ]; then
    REPLICAS=3
fi

echo "Scaling down to $REPLICAS replicas"

# Check current load
CURRENT_QPS=$(curl -s https://api.noip.yourdomain.com/api/performance/metrics | jq '.requestsPerSecond')

if [ "$CURRENT_QPS" -gt 100 ]; then
    echo "Warning: Current QPS ($CURRENT_QPS) is high. Consider keeping more replicas."
    read -p "Continue with scale down? (y/n): " confirm
    if [ "$confirm" != "y" ]; then
        exit 1
    fi
fi

# Scale deployment
kubectl scale deployment noip-api --replicas=$REPLICAS -n noip-production

# Wait for scale down
kubectl wait --for=condition=ready pod -l app=noip-api -n noip-production --timeout=300s

# Verify scaling
kubectl get pods -n noip-production -l app=noip-api

echo "Scale down completed successfully"
```

### Vertical Scaling

#### Update Resource Limits

```bash
#!/bin/bash
# vertical-scale.sh

CPU_LIMIT=$1
MEMORY_LIMIT=$2

if [ -z "$CPU_LIMIT" ]; then
    CPU_LIMIT="2000m"
fi

if [ -z "$MEMORY_LIMIT" ]; then
    MEMORY_LIMIT="4Gi"
fi

echo "Scaling vertically to CPU: $CPU_LIMIT, Memory: $MEMORY_LIMIT"

# Update deployment
kubectl patch deployment noip-api -n noip-production -p "{
  \"spec\": {
    \"template\": {
      \"spec\": {
        \"containers\": [{
          \"name\": \"noip-api\",
          \"resources\": {
            \"limits\": {
              \"cpu\": \"$CPU_LIMIT\",
              \"memory\": \"$MEMORY_LIMIT\"
            }
          }
        }]
      }
    }
  }
}"

# Restart deployment to apply new limits
kubectl rollout restart deployment/noip-api -n noip-production

# Wait for rollout
kubectl rollout status deployment/noip-api -n noip-production --timeout=600s

echo "Vertical scaling completed successfully"
```

---

## Compliance Management

### Automated Compliance Checks

```bash
#!/bin/bash
# automated-compliance-check.sh

COMPLIANCE_FRAMEWORKS=("soc2-type2" "iso27001" "noip-enterprise")
REPORT_DIR="/compliance-reports/$(date +%Y%m%d)"
mkdir -p $REPORT_DIR

echo "Running automated compliance checks..."

for framework in "${COMPLIANCE_FRAMEWORKS[@]}"; do
    echo "Checking $framework compliance..."

    # Run assessment
    curl -X POST "https://api.noip.yourdomain.com/api/compliance/assessment/$framework" \
        -H "Content-Type: application/json" \
        -o "$REPORT_DIR/${framework}-assessment.json"

    # Generate report
    curl -X GET "https://api.noip.yourdomain.com/api/compliance/report/$framework/export?format=json" \
        -o "$REPORT_DIR/${framework}-report.json"

    # Export PDF
    curl -X GET "https://api.noip.yourdomain.com/api/compliance/report/$framework/export?format=pdf" \
        -o "$REPORT_DIR/${framework}-report.pdf"

    echo "$framework check completed"
done

# Generate summary report
echo "Generating compliance summary..."
cat > "$REPORT_DIR/compliance-summary.md" << EOF
# Compliance Report - $(date +%Y-%m-%d)

## Frameworks Assessed
$(for framework in "${COMPLIANCE_FRAMEWORKS[@]}"; do echo "- $framework"; done)

## Overall Status
$(curl -s https://api.noip.yourdomain.com/api/compliance/dashboard | jq -r '.overview')

## Critical Issues
$(curl -s https://api.noip.yourdomain.com/api/compliance/dashboard | jq -r '.alerts[] | select(.severity == "critical")')

## Next Steps
1. Review detailed reports in this directory
2. Address any critical findings
3. Update compliance evidence
4. Schedule follow-up assessments
EOF

echo "Automated compliance checks completed"
echo "Reports saved to: $REPORT_DIR"
```

### Evidence Management

```bash
#!/bin/bash
# evidence-management.sh

EVIDENCE_DIR="/compliance-evidence/$(date +%Y%m)"
mkdir -p $EVIDENCE_DIR

echo "Collecting compliance evidence..."

# Collect configuration evidence
kubectl get configmaps -n noip-production -o yaml > "$EVIDENCE_DIR/configmaps.yaml"
kubectl get secrets -n noip-production -o yaml > "$EVIDENCE_DIR/secrets.yaml" # Sanitize first!

# Collect network policies
kubectl get networkpolicies -n noip-production -o yaml > "$EVIDENCE_DIR/network-policies.yaml"

# Collect RBAC evidence
kubectl get roles,rolebindings -n noip-production -o yaml > "$EVIDENCE_DIR/rbac.yaml"

# Collect pod security evidence
kubectl get pods -n noip-production -o jsonpath='{.items[*].spec.securityContext}' > "$EVIDENCE_DIR/pod-security.yaml"

# Collect monitoring evidence
kubectl get hpa,vpa -n noip-production -o yaml > "$EVIDENCE_DIR/auto-scaling.yaml"

# Generate evidence index
cat > "$EVIDENCE_DIR/evidence-index.md" << EOF
# Compliance Evidence Index - $(date +%Y-%m)

## Configuration Evidence
- configmaps.yaml - Application configuration
- secrets.yaml - Encrypted secrets (sanitized)
- network-policies.yaml - Network security policies

## Access Control Evidence
- rbac.yaml - Role-based access control
- pod-security.yaml - Pod security contexts

## Infrastructure Evidence
- auto-scaling.yaml - Auto-scaling configurations

## Collection Date
$(date)

## Collected By
NOIP Platform Compliance Automation
EOF

echo "Compliance evidence collected"
echo "Evidence saved to: $EVIDENCE_DIR"
```

---

## Conclusion

These operational runbooks provide comprehensive procedures for managing the NOIP platform in production environments. Regular review and updates of these runbooks are essential to maintain operational excellence.

### Runbook Maintenance

- **Monthly**: Review and update runbooks
- **Quarterly**: Major procedure reviews
- **Annually**: Complete runbook overhaul

### Contact Information

- **Platform Lead**: platform-lead@yourdomain.com
- **On-call Engineer**: oncall@yourdomain.com
- **Security Team**: security@yourdomain.com
- **Emergency Hotline**: +1-xxx-xxx-xxxx

### Documentation

- **Service Architecture**: /docs/architecture.md
- **API Documentation**: /docs/api.md
- **Security Guidelines**: /docs/security.md

---

**Version**: 1.0.0
**Last Updated**: 2025-01-26
**Maintainer**: NOIP Platform Team