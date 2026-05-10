// Branded identifier primitives for the shared kernel.
// Branding gives nominal typing on top of `string` so a `UserId` cannot
// be silently used where a `RoleId` is expected.

import { randomUUID } from 'crypto';

/**
 * Brand applied via an intersection type. The `_t` field is phantom —
 * it does not exist at runtime; it only serves to make the type nominal
 * to TypeScript's structural type checker.
 */
export type Id<Tag extends string> = string & { readonly _t: Tag };

export type UserId = Id<'UserId'>;
export type RoleId = Id<'RoleId'>;
export type PermissionId = Id<'PermissionId'>;
export type SessionId = Id<'SessionId'>;
export type ApiKeyId = Id<'ApiKeyId'>;
export type ServiceAccountId = Id<'ServiceAccountId'>;
export type ClusterId = Id<'ClusterId'>;
export type ScanId = Id<'ScanId'>;
export type SnapshotId = Id<'SnapshotId'>;
export type DriftId = Id<'DriftId'>;
export type FindingId = Id<'FindingId'>;
export type PolicyId = Id<'PolicyId'>;
export type ReportId = Id<'ReportId'>;
export type AnalysisId = Id<'AnalysisId'>;
export type PatternId = Id<'PatternId'>;
export type ContextId = Id<'ContextId'>;
export type ProbeId = Id<'ProbeId'>;
export type LoadTestId = Id<'LoadTestId'>;
export type SLOId = Id<'SLOId'>;
export type DashboardId = Id<'DashboardId'>;
export type WidgetId = Id<'WidgetId'>;
export type AuditId = Id<'AuditId'>;
export type EventId = Id<'EventId'>;

// RFC 4122 UUID (any version). We currently emit v4; we want to accept
// inbound v7 ids once a generator is adopted, so the regex is permissive
// across versions 1-8.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Mints a new branded id.
 * TODO: switch to UUIDv7 once a stable generator lands in Node stdlib or
 * we adopt a tiny dependency. v7 is sortable by time which improves
 * locality on persisted aggregates.
 */
export function newId<T extends Id<string>>(): T {
  return randomUUID() as T;
}

/**
 * Validates that `raw` is a UUID and returns it as the branded type.
 * Throws if the input is not a well-formed UUID.
 */
export function parseId<T extends Id<string>>(raw: string): T {
  if (typeof raw !== 'string' || !UUID_REGEX.test(raw)) {
    throw new Error(`Invalid id: ${String(raw)}`);
  }
  return raw as T;
}

/**
 * Non-throwing variant. Returns null when `raw` is not a UUID.
 */
export function tryParseId<T extends Id<string>>(raw: string): T | null {
  if (typeof raw !== 'string' || !UUID_REGEX.test(raw)) return null;
  return raw as T;
}
