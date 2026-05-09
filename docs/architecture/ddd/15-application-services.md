# DDD-15: Application Services

Application services orchestrate use cases. They are *thin*: they do not
contain domain rules (those live in entities, value objects, and domain
services), nor HTTP concerns (those live in controllers).

## Responsibilities

An application service:

1. Resolves authorization with the IAM public API.
2. Loads the aggregate(s) needed for the command.
3. Invokes domain methods.
4. Persists changes through repositories within a single transaction.
5. Emits domain events via the outbox.
6. Returns a DTO suitable for the controller to serialise.

Application services do **not**:

- Touch `req` / `res` / Express types.
- Bypass repositories to query Mongo directly.
- Cross context boundaries except via another context's public API.

## Naming convention

`<Context>Service` for the canonical orchestrator (existing
`AuthService`, `DiscoveryService`, `SecurityService`, `ComplianceService`,
`AIService`, `PerformanceService`, `DashboardService`).

Where a context has multiple use-case clusters, additional services follow
`<Subject>Service` (e.g. `UserAdminService`, `RoleAdminService`,
`ApiKeyService`, `ReportService`).

## Method shape

```ts
class FooService {
  constructor(
    private readonly fooRepo: FooRepository,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly iam: IamPublicApi,
    private readonly logger: Logger,
  ) {}

  async doThing(cmd: DoThingCommand, principal: Principal): Promise<DoThingResult> {
    const decision = await this.iam.authorize(principal, 'foo', 'doThing');
    if (decision.kind === 'deny') throw new ForbiddenError(decision.reason);

    return this.unitOfWork.run(async (tx) => {
      const foo = await this.fooRepo.findById(cmd.id, tx);
      if (!foo) throw new NotFoundError('foo', cmd.id);

      const events = foo.doThing(cmd, this.clock.now());

      await this.fooRepo.save(foo, tx);
      await this.bus.publishMany(events, tx);

      return mapToDto(foo);
    });
  }
}
```

## Cross-context calls

When a service needs data owned by another context, it calls **only** that
context's public API barrel. Example: `DashboardService.getWidgetData` calls
`security.api.listFindings(...)` rather than reading the `findings`
collection.

## Errors

A small, typed taxonomy of errors that controllers map to HTTP status codes:

| Error | Status | Meaning |
|-------|--------|---------|
| `ValidationError` | 400 | Input failed schema/business validation. |
| `UnauthorizedError` | 401 | No / invalid credentials. |
| `ForbiddenError` | 403 | Authenticated but not authorised. |
| `NotFoundError` | 404 | Aggregate or resource not found. |
| `ConflictError` | 409 | State conflict (e.g. unique violation). |
| `OptimisticLockError` | 409 | Stale write; retry. |
| `RateLimitError` | 429 | Bucket exceeded. |
| `BackpressureError` | 503 | Provider/circuit-breaker open. |
| `InternalError` | 500 | Unexpected. |

Defined in `src/shared/errors/`; controllers and middleware map to the HTTP
layer; services raise these errors only.

## Idempotency

For unsafe operations exposed over HTTP, services accept an
`Idempotency-Key` header and store `(key, hash(request)) → response` in
Redis with a 24-hour TTL. Subsequent identical requests return the cached
response; conflicting requests (same key, different body hash) return 409.

## Cancellation

Long-running services (security scans, AI analyses) accept an
`AbortSignal` and propagate it to upstream calls (Anthropic, kube API).
Cancellation is exposed via `DELETE /…/scan/:id` for scans.

## Testing

- Unit tests use in-memory fakes for repositories and a recording event bus.
- Integration tests run the service against real Mongo/Redis (Testcontainers)
  and assert both persistence and emitted events.
- Contract tests (per public API barrel) ensure cross-context callers are
  not broken by signature drift.

## Dependency injection

We compose services manually in `src/app.ts` today (ADR-0003). Each context
owns a `composeContext(deps)` function that returns the bag of services it
exports through its barrel. The composition root in `src/app.ts` wires
contexts together by passing each context's `api` into the others'
composers, with no other context-to-context coupling.

```ts
// pseudo
const iam = composeIam({ db, redis, mailer, clock });
const audit = composeAudit({ db, bus });
const discovery = composeDiscovery({ db, k8sClient, bus, iam: iam.api });
const security = composeSecurity({ db, bus, iam: iam.api, discovery: discovery.api });
const ai = composeAI({ db, anthropic, chroma, iam: iam.api, discovery: discovery.api, security: security.api });
const performance = composePerformance({ db, bus, prometheus });
const dashboard = composeDashboard({ db, iam: iam.api, security: security.api, ai: ai.api, performance: performance.api });

const app = composeHttp({ iam, audit, discovery, security, ai, performance, dashboard });
```

## Concurrency & throughput

- The Express process is async-first; services use Promises and avoid
  blocking the event loop.
- CPU-bound work (hashing, embedding, PDF rendering) is offloaded:
  - Argon2 verification uses the native binding.
  - PDF rendering runs in a worker pool.
  - RAG ingestion runs in Python sidecars.
