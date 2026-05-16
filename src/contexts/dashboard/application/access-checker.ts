// Domain service that enforces a `SharePolicy` against a request
// principal. Pure logic — no I/O, no clock — so it can be unit-tested
// directly and reused from any caller (HTTP routes, the data resolver,
// future websocket gateway, etc.).
//
// Rules (DDD-10):
//   - `private`        — only the owner sees it.
//   - `role-scoped`    — owner OR any principal carrying at least one
//                        of the policy's roles.
//   - `organisation`   — anyone authenticated.
//
// The checker does NOT make HTTP responses. The HTTP layer translates
// `canRead === false` into a 403; the service layer translates a
// missing principal into a 401.

import type { UserId } from '../../../shared/kernel';
import type { Dashboard } from '../domain/dashboard';
import type { SharePolicy } from '../domain/value-objects';

/**
 * Caller-supplied principal shape. We deliberately keep it small so
 * callers only need to pass the fields the checker cares about; the
 * IAM context can hand us a denser object and we ignore the rest.
 */
export interface Principal {
  userId: UserId;
  roles?: ReadonlyArray<string>;
}

export class AccessChecker {
  /**
   * Returns true when the principal is allowed to read the dashboard.
   * The owner is always allowed regardless of `share`.
   */
  canRead(dashboard: Dashboard, principal: Principal | null): boolean {
    if (!principal || !principal.userId) return false;
    if (dashboard.ownedBy.userId === principal.userId) return true;
    return this.policyAllows(dashboard.share, principal);
  }

  /**
   * Only the owner may mutate a dashboard. We keep the API explicit so
   * future role-based admin grants can plug in without changing call
   * sites.
   */
  canWrite(dashboard: Dashboard, principal: Principal | null): boolean {
    if (!principal || !principal.userId) return false;
    return dashboard.ownedBy.userId === principal.userId;
  }

  /**
   * Pure policy evaluator — exposed so the resolver can test a synthetic
   * dashboard / policy combination without rebuilding a full aggregate.
   */
  policyAllows(policy: SharePolicy, principal: Principal): boolean {
    switch (policy.visibility) {
      case 'private':
        return false;
      case 'organisation':
        return true;
      case 'role-scoped': {
        const roles = policy.roles ?? [];
        const have = new Set(principal.roles ?? []);
        for (const r of roles) {
          if (have.has(r)) return true;
        }
        return false;
      }
      default:
        return false;
    }
  }
}
