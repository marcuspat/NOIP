// Re-export shim — the audit middleware moved to
// `src/contexts/audit/http/audit-middleware.ts` as part of DDD-11
// bounded-context extraction. Legacy imports from `./middleware/audit.middleware`
// (notably `src/app.ts` and `src/routes/auth.routes.ts`) keep compiling
// unchanged via this barrel; new callers should reach for
// `src/contexts/audit/api` or `src/contexts/audit/http/audit-middleware`.

export {
  NON_AUDITED_PATHS,
  auditMiddleware,
  setAuditAppender,
  addRequestTiming,
  AuditMiddleware,
} from '../contexts/audit/http/audit-middleware';
export type { AuditMiddlewareOptions } from '../contexts/audit/http/audit-middleware';
