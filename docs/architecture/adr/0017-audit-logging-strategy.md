# ADR-0017: Audit logging strategy

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Security, Compliance
- **Tags:** security, compliance, observability

## Context and Problem Statement

Compliance frameworks (SOC2 CC7, ISO27001 A.12.4, HIPAA §164.312(b)) require
durable, tamper-evident records of who did what, when, against which
resource. The codebase already has `src/middleware/audit.middleware.ts` and a
domain `AuditLog` type.

## Decision Drivers

- Capture *every* state-changing API call and *every* security-sensitive read.
- Preserve a 365-day retention window (`AUDIT_RETENTION_DAYS=365`).
- Support efficient filtering by user, resource, action, time.
- Avoid logging sensitive payloads (passwords, MFA secrets, session tokens).
- Be append-only; expose evidence-collection endpoints for auditors.

## Considered Options

1. **MongoDB collection `auditLogs` populated by middleware, forwarded to a
   SIEM.**
2. **Direct stream to a SIEM only** (no DB copy).
3. **Append-only object storage** (S3 with Object Lock / WORM).

## Decision Outcome

**Chosen option:** **MongoDB primary with periodic export to immutable
storage** (S3 Glacier with Object Lock for long-term preservation) and live
forwarding to the SIEM via Fluentd/Vector.

### What gets logged

The `AuditMiddleware` captures, for every authenticated request:

```ts
{
  userId | serviceAccountId,
  action: 'auth.login' | 'iam.role.create' | 'security.scan.run' | …,
  resource: 'user' | 'role' | 'scan' | …,
  resourceId?: string,
  details: { method, path, statusCode, query, sanitizedBody },
  ipAddress, userAgent, sessionId,
  timestamp
}
```

### Sanitisation rules

- Header denylist: `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`.
- Body field denylist: `password`, `passwordConfirm`, `currentPassword`,
  `newPassword`, `mfaCode`, `mfaSecret`, `backupCode`, `token`,
  `clientSecret`, `privateKey`, `cert`.
- Maximum body size: `AUDIT_MAX_BODY_SIZE=10240` (truncate with marker).
- Sanitisation is applied *before* serialisation; centrally implemented in
  `src/middleware/audit.middleware.ts`.

### Indexing

`auditLogs` indexes:

- `(timestamp: -1)`
- `(userId, timestamp: -1)`
- `(action, timestamp: -1)`
- `(resource, resourceId, timestamp: -1)`

A TTL is **NOT** set on the collection — retention is enforced by an export
job that moves entries older than 30 days to immutable archive and after 395
days hard-deletes from Mongo.

### Tamper evidence

Each record stores a chained hash:

```
hash_n = sha256(hash_{n-1} || canonical_json(record_n))
```

The latest hash is published daily to a signed log
(transparency log on Sigstore Rekor — separate ADR for the implementation
detail).

### Positive Consequences

- Defensible audit trail for compliance evidence.
- Searchable in Mongo for incident response.
- Tamper-evident chain detects post-hoc edits.

### Negative Consequences / Trade-offs

- Storage cost; mitigated by lifecycle policy.
- Hash chain requires a single writer per shard or a serialised post-write
  step; we accept the throughput trade-off for write rates expected at our
  scale (≪ 10k/s).

## References

- `src/middleware/audit.middleware.ts`
- `src/types/auth.types.ts:AuditLog`
- ADR-0018 (security events)
- DDD-11 (Audit & Observability context)
