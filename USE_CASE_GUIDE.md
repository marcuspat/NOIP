# NOIP Platform — Use Case Guide

This guide explains what the NetOps Intelligence Platform (NOIP) does, who benefits from it, and how to use its API for concrete real-world tasks. Read the [README](README.md) first for installation and prerequisites.

---

## What Problem Does NOIP Solve?

Modern infrastructure teams operate across many domains at once: Kubernetes clusters, security posture, compliance frameworks, performance baselines. Each domain typically has its own tool, its own data format, and its own access model. The result is **context switching, fragmented data, and manual correlation work**.

NOIP provides **a single authenticated REST API** that:

1. Discovers and tracks Kubernetes cluster state over time (snapshots + drift detection)
2. Runs security and vulnerability analysis and surfaces prioritized recommendations
3. Evaluates infrastructure against compliance control frameworks (SOC 2, ISO 27001, GDPR, PCI-DSS, HIPAA)
4. Sends infrastructure context to an AI model for natural-language analysis
5. Runs load tests and collects performance metrics
6. Assembles live dashboards from service data

All of this is protected by JWT authentication with MFA, RBAC, and Redis-backed rate limiting.

---

## Who Is It For?

| Persona | Primary Use |
|---|---|
| **Platform / DevOps Engineer** | Automate cluster scanning, track drift, integrate scan results into CI/CD |
| **Security Engineer** | Get a machine-readable security score, vulnerability list, and recommended remediations |
| **Compliance Manager** | Generate gap reports against SOC 2 or ISO 27001, submit evidence, track assessments |
| **SRE / Performance Engineer** | Run load tests against staging, collect p95/p99 baselines, identify bottlenecks |
| **Engineering Manager / Executive** | Request an AI-written natural-language summary of current infrastructure health |
| **Dashboard / Tooling Developer** | Embed NOIP widgets into an internal portal via the dashboard API |

---

## Use Case 1 — Kubernetes Drift Detection

### The scenario

Your team pushes a change to the cluster. A resource that should not have changed gets modified. You want to know what changed, when, and how severe the drift is.

### How NOIP handles it

Every call to `POST /api/v1/discovery/scan`:

1. Queries the live cluster for all resources (pods, deployments, services, configmaps, etc.)
2. Fingerprints each resource with a canonical SHA-256 hash (volatile fields like `resourceVersion` are stripped before hashing)
3. Saves an immutable `Snapshot` document (mutations are blocked at the model layer)
4. Compares the new snapshot against the most recent previous snapshot
5. Writes a `DriftReport` listing added, removed, and modified resources with severity labels
6. Emits a `discovery.DriftDetected` domain event (subscribe via the internal event bus for alerting integrations)

### API walkthrough

**Trigger a scan:**

```bash
curl -X POST http://localhost:3000/api/v1/discovery/scan \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Content-Type: application/json'
```

```json
{
  "success": true,
  "data": {
    "clusterId": "cluster-abc123",
    "snapshotId": "snap-def456",
    "resourceCount": 142,
    "driftReport": {
      "id": "drift-ghi789",
      "severity": "high",
      "items": [
        {
          "kind": "ClusterRoleBinding",
          "name": "system:admin-binding",
          "changeType": "removed",
          "severity": "critical"
        },
        {
          "kind": "Deployment",
          "name": "api-gateway",
          "changeType": "modified",
          "severity": "medium",
          "diff": { "spec.replicas": { "from": 3, "to": 1 } }
        }
      ]
    }
  }
}
```

**Get all resources from the last scan:**

```bash
curl http://localhost:3000/api/v1/discovery/resources \
  -H 'Authorization: Bearer <access-token>'
```

### Benefit

Drift detection replaces manual `kubectl diff` workflows. Because snapshots are immutable and fingerprinted, you have a tamper-evident audit trail of every cluster state change — useful for incident post-mortems and compliance audits.

---

## Use Case 2 — Continuous Security Posture

### The scenario

Your team wants an automated security score checked on every pull request merge, and a list of the highest-priority issues to remediate this sprint.

### How NOIP handles it

The security service aggregates findings from pod-level analysis, network scanning, and secret detection into a normalized 0–100 score. Findings are SHA-256 fingerprinted so the same issue is never double-counted — recurrences update `lastSeenAt` rather than creating duplicate records.

### API walkthrough

**Get current security score:**

```bash
curl http://localhost:3000/api/v1/security/score \
  -H 'Authorization: Bearer <access-token>'
```

```json
{
  "success": true,
  "data": {
    "score": 62,
    "grade": "C",
    "breakdown": {
      "podSecurity": 45,
      "networkSecurity": 78,
      "secretScanning": 91,
      "accessControl": 55
    },
    "criticalIssues": 2,
    "highIssues": 7
  }
}
```

**Get prioritized recommendations:**

```bash
curl http://localhost:3000/api/v1/security/recommendations \
  -H 'Authorization: Bearer <access-token>'
```

```json
{
  "success": true,
  "data": {
    "recommendations": [
      {
        "id": "sec-001",
        "severity": "critical",
        "title": "Privileged containers detected",
        "description": "3 pods are running with privileged: true in the default namespace",
        "remediation": "Set securityContext.privileged: false and drop ALL capabilities",
        "affectedResources": ["pod/api-worker-1", "pod/api-worker-2", "pod/api-worker-3"]
      },
      {
        "id": "sec-002",
        "severity": "high",
        "title": "Network policy missing for database namespace",
        "description": "The db namespace has no NetworkPolicy — all pods can reach the database directly",
        "remediation": "Apply a NetworkPolicy that restricts ingress to the api namespace only"
      }
    ]
  }
}
```

**Run a full security scan:**

```bash
curl -X POST http://localhost:3000/api/v1/security/scan \
  -H 'Authorization: Bearer <access-token>'
```

### Benefit

Integrate the `/score` endpoint into your CI/CD pipeline. Fail the pipeline if the score drops below a threshold or if any `critical` severity findings appear since the last scan.

---

## Use Case 3 — Compliance Gap Analysis

### The scenario

Your company is preparing for a SOC 2 Type II audit. The compliance manager wants to know which controls are currently failing, what evidence exists, and which gaps need remediation before the audit window.

### How NOIP handles it

The compliance service maintains control frameworks (SOC 2, ISO 27001, GDPR, PCI-DSS, HIPAA). Each control maps to observed infrastructure behavior. You can submit evidence against controls and generate gap reports.

### API walkthrough

**List available frameworks:**

```bash
curl http://localhost:3000/api/v1/compliance/frameworks \
  -H 'Authorization: Bearer <access-token>'
```

```json
{
  "success": true,
  "data": {
    "frameworks": [
      { "id": "soc2", "name": "SOC 2", "controlCount": 64 },
      { "id": "iso27001", "name": "ISO 27001", "controlCount": 114 },
      { "id": "gdpr", "name": "GDPR", "controlCount": 42 },
      { "id": "pci-dss", "name": "PCI-DSS", "controlCount": 78 },
      { "id": "hipaa", "name": "HIPAA", "controlCount": 54 }
    ]
  }
}
```

**Generate a SOC 2 compliance report:**

```bash
curl -X POST http://localhost:3000/api/v1/compliance/report \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "frameworkId": "soc2",
    "period": {
      "start": "2025-01-01T00:00:00Z",
      "end": "2025-03-31T23:59:59Z"
    }
  }'
```

```json
{
  "success": true,
  "data": {
    "reportId": "rpt-abc123",
    "framework": "SOC 2",
    "period": { "start": "2025-01-01", "end": "2025-03-31" },
    "summary": {
      "totalControls": 64,
      "passing": 48,
      "failing": 11,
      "notEvaluated": 5,
      "complianceScore": 81
    },
    "gaps": [
      {
        "controlId": "CC6.1",
        "title": "Logical Access Controls",
        "status": "failing",
        "finding": "MFA is not enforced for all privileged accounts",
        "remediation": "Enable MFA requirement on all admin-role users"
      }
    ]
  }
}
```

**Submit evidence for a control:**

```bash
curl -X POST http://localhost:3000/api/v1/compliance/evidence \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "controlId": "CC6.1",
    "evidenceType": "screenshot",
    "description": "MFA enforcement enabled for all admin accounts as of 2025-02-15",
    "collectedAt": "2025-02-15T10:00:00Z"
  }'
```

### Benefit

Instead of manually cross-referencing control frameworks with infrastructure state, compliance managers get a structured gap report they can hand directly to auditors. Evidence submission creates a timestamped audit trail.

---

## Use Case 4 — AI-Powered Infrastructure Summary

### The scenario

The CTO asks: "What is the current health of our infrastructure and what are the top 3 things we should fix this week?" You want a human-readable answer grounded in real infrastructure data, not a static report template.

### How NOIP handles it

The AI service accepts infrastructure context (discovery scan results, security score, recent drift, top findings) and sends it to a configured LLM (Anthropic Claude via the `ANTHROPIC_API_KEY`). The service uses a hexagonal port pattern — in development a mock client is used; in production the real Claude API client is wired in.

### API walkthrough

**Comprehensive infrastructure analysis:**

```bash
curl -X POST http://localhost:3000/api/v1/ai/analyze/infrastructure \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "context": {
      "clusterName": "prod-us-east-1",
      "includeSecurityScore": true,
      "includeDriftHistory": true,
      "includeTopFindings": true
    },
    "outputFormat": "executive-summary"
  }'
```

```json
{
  "success": true,
  "data": {
    "analysisId": "ai-xyz789",
    "summary": "The prod-us-east-1 cluster is currently operating at 62/100 security score (Grade C). The three highest-priority actions this week are: (1) Remediate privileged container configurations in 3 API worker pods — this is a critical severity finding that could allow container escape. (2) Apply NetworkPolicy to the database namespace to prevent lateral movement. (3) Enforce MFA for all admin-role accounts to satisfy SOC 2 CC6.1.",
    "topActions": [
      { "priority": 1, "action": "Remove privileged: true from api-worker pods", "estimatedEffort": "2 hours" },
      { "priority": 2, "action": "Apply NetworkPolicy to db namespace", "estimatedEffort": "1 hour" },
      { "priority": 3, "action": "Enable MFA enforcement on admin accounts", "estimatedEffort": "30 minutes" }
    ],
    "modelUsed": "claude-3-opus-20240229",
    "tokensUsed": 1847
  }
}
```

**Security-focused analysis:**

```bash
curl -X POST http://localhost:3000/api/v1/ai/analyze/security \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Content-Type: application/json' \
  -d '{"depth": "detailed", "includeRemediation": true}'
```

### Benefit

Replaces manual report writing. An engineer triggers the endpoint before a weekly team standup and pastes the output directly into the meeting agenda.

---

## Use Case 5 — Performance Baseline and Load Testing

### The scenario

Before releasing a new API version, you want to establish a p95 response time baseline and confirm the system can handle 1,000 concurrent users without degradation.

### How NOIP handles it

The performance service accepts load test configurations (concurrent users, duration, ramp-up time, HTTP scenarios with weights), executes them internally, and returns statistical results with identified bottlenecks and recommendations.

### API walkthrough

**Run a custom load test:**

```bash
curl -X POST http://localhost:3000/api/v1/performance/test \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "targetUrl": "https://api.example.com",
    "concurrentUsers": 500,
    "duration": 300,
    "rampUpTime": 60,
    "requestRate": 50,
    "scenarios": [
      {
        "name": "Health Check",
        "weight": 20,
        "method": "GET",
        "endpoint": "/health",
        "expectedStatus": 200,
        "timeout": 5000
      },
      {
        "name": "API Authentication",
        "weight": 30,
        "method": "POST",
        "endpoint": "/api/v1/auth/login",
        "expectedStatus": 200,
        "timeout": 10000
      },
      {
        "name": "Data Query",
        "weight": 50,
        "method": "GET",
        "endpoint": "/api/v1/discovery/resources",
        "expectedStatus": 200,
        "timeout": 15000
      }
    ]
  }'
```

```json
{
  "success": true,
  "data": {
    "testId": "perf-test-001",
    "totalRequests": 15000,
    "successfulRequests": 14823,
    "failedRequests": 177,
    "averageResponseTime": 245,
    "p50ResponseTime": 198,
    "p95ResponseTime": 612,
    "p99ResponseTime": 1834,
    "requestsPerSecond": 50.0,
    "errorRate": 1.18,
    "bottlenecks": [
      {
        "type": "high_p99",
        "severity": "warning",
        "description": "p99 response time (1834ms) exceeds 1000ms threshold",
        "recommendation": "Investigate slow query paths in /api/v1/discovery/resources — consider adding pagination or caching"
      }
    ],
    "recommendations": [
      "Consider enabling Redis response caching for read-heavy discovery endpoints",
      "The data query scenario at p99 1834ms suggests a slow Mongoose query — add compound indexes on (clusterId, kind)",
      "Error rate 1.18% under 500 concurrent users — investigate timeout handling in the auth flow"
    ]
  }
}
```

**Use a standard configuration:**

```bash
# Get the three standard configs (light: 100 users, medium: 1000 users, heavy: 10000 users)
curl http://localhost:3000/api/v1/performance/configs \
  -H 'Authorization: Bearer <access-token>'
```

**Compare with historical results:**

```bash
curl http://localhost:3000/api/v1/performance/history \
  -H 'Authorization: Bearer <access-token>'
```

### Benefit

Performance baselines are stored and queryable. You can run a load test before and after a deploy and compare p95 to confirm no regression — without needing a separate k6 or JMeter setup.

---

## Use Case 6 — Dashboard Embedding

### The scenario

Your internal engineering portal (a React app) wants to embed live infrastructure health widgets without duplicating authentication or data-fetching logic.

### How NOIP handles it

The dashboard service exposes composable widgets. Each widget has a type (security score, cluster health, compliance status, performance metrics) and returns live data on demand.

### API walkthrough

**Create a security score widget:**

```bash
curl -X POST http://localhost:3000/api/v1/dashboard \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "security-score",
    "title": "Production Security Posture",
    "config": { "clusterId": "prod-us-east-1" }
  }'
```

**Fetch live widget data:**

```bash
curl http://localhost:3000/api/v1/dashboard/widget/wdg-abc123/data \
  -H 'Authorization: Bearer <access-token>'
```

```json
{
  "success": true,
  "data": {
    "widgetId": "wdg-abc123",
    "type": "security-score",
    "value": 62,
    "trend": "declining",
    "delta": -4,
    "lastUpdated": "2025-05-24T09:00:00Z"
  }
}
```

### Benefit

Your portal makes one authenticated API call per widget rather than integrating with five different monitoring tools. The NOIP token model means the portal never needs to hold cluster credentials directly.

---

## Authentication Reference

Every API call requires a Bearer token. Here is the minimal flow:

```bash
# 1. Register (first time)
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"engineer@example.com","password":"P@ssw0rd!23","firstName":"Jane","lastName":"Doe"}'

# 2. Login
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"engineer@example.com","password":"P@ssw0rd!23"}' \
  | jq -r '.data.accessToken')

# 3. Use the token
curl http://localhost:3000/api/v1/security/score \
  -H "Authorization: Bearer $TOKEN"

# 4. Refresh before it expires (15-minute access token)
curl -X POST http://localhost:3000/api/v1/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<your-refresh-token>"}'
```

---

## Integrating with CI/CD

A minimal CI check that fails the pipeline on a security score drop:

```bash
#!/bin/bash
# ci-security-gate.sh

TOKEN=$(curl -s -X POST $NOIP_URL/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$NOIP_USER\",\"password\":\"$NOIP_PASS\"}" \
  | jq -r '.data.accessToken')

SCORE=$(curl -s $NOIP_URL/api/v1/security/score \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.data.score')

echo "Security score: $SCORE"

if [ "$SCORE" -lt 70 ]; then
  echo "ERROR: Security score $SCORE is below threshold 70. Blocking deploy."
  exit 1
fi

CRITICAL=$(curl -s $NOIP_URL/api/v1/security/score \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.data.criticalIssues')

if [ "$CRITICAL" -gt 0 ]; then
  echo "ERROR: $CRITICAL critical security issues detected. Blocking deploy."
  exit 1
fi

echo "Security gate passed."
```

---

## What Is Not Yet Implemented

NOIP is an MVP with real plumbing and mock external clients. Be aware of these boundaries:

| Feature | Status |
|---|---|
| REST API, auth, session management | Fully implemented |
| Discovery service (cluster scan, snapshot, drift) | Fully implemented |
| Finding dedup + auto-resolve | Fully implemented |
| Security score + recommendations | Implemented (simulated scanner) |
| Compliance frameworks + gap reports | Implemented (SOC 2, ISO 27001, GDPR, PCI-DSS, HIPAA) |
| Performance load testing | Implemented (simulated engine) |
| Dashboard widgets | Implemented |
| AI analysis (real LLM calls) | Port implemented; real Claude client wired via `ANTHROPIC_API_KEY` |
| Live kubectl cluster queries | Mock client (real kubeconfig integration is the next milestone) |
| Email notifications (MFA, reset) | Nodemailer configured; requires SMTP credentials |
| Prometheus metrics endpoint | Configured in k8s; `/metrics` scrape endpoint not yet wired |
| Playwright E2E tests | Scaffold present; requires running server |

---

## Getting Help

- Open an issue: [github.com/marcuspat/noip/issues](https://github.com/marcuspat/noip/issues)
- Architecture decisions: [`docs/adr/`](docs/adr/)
- Domain model: [`docs/ddd/`](docs/ddd/)
- Validation evidence: [`VALIDATION_REPORT.md`](VALIDATION_REPORT.md)
