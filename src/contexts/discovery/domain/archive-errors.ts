// Archive-specific typed errors. Co-located with the archiver domain
// service so adapters and consumers both reach the same definitions.
//
// We intentionally keep these outside `src/shared/errors` to avoid a
// merge collision with Phase 5 (which is editing the shared kernel
// in parallel). Both errors extend `DomainError` so the HTTP edge's
// `toHttpResponse` handles them with no special casing.

import { DomainError } from '../../../shared/errors';

/**
 * The archive store cannot operate because a required runtime
 * dependency (e.g. `@aws-sdk/client-s3`) or environment variable is
 * missing. 503 because the caller can retry after operator
 * intervention rather than a code change.
 */
export class NotConfiguredError extends DomainError {
  constructor(
    message = 'Archive store is not configured',
    details?: Record<string, unknown>
  ) {
    super(message, 'ARCHIVE_NOT_CONFIGURED', 503, details);
  }
}

/**
 * A round-trip integrity check failed — typically because the
 * SHA-256 of the downloaded archive does not match what we
 * uploaded. Treated as 502 (the upstream store gave us bad data);
 * the archiver MUST NOT delete the Mongo row when this is thrown.
 */
export class IntegrityError extends DomainError {
  constructor(
    message = 'Archive integrity check failed',
    details?: Record<string, unknown>
  ) {
    super(message, 'ARCHIVE_INTEGRITY', 502, details);
  }
}
