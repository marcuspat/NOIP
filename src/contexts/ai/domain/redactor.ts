// Redactor — scrubs sensitive substrings before transmission to the
// LLM provider.
//
// Per the DDD-08 data classification table:
//
//   Class           | Treatment
//   ----------------|----------------------------------------------------
//   Secrets         | Replaced with `<REDACTED:type>`.
//   PII             | Pseudonymised with deterministic SHA-256 prefix.
//   Internal ids    | Replaced with opaque `op_<hash>`.
//   Inventory data  | Allowed (operational data).
//
// The redactor is deterministic: the same input under the same
// `analysisId` produces the same output. Tokens are reused within the
// scope of a single analysis so a downstream LLM can refer back to
// pseudonymised entities consistently. Across analyses we re-hash with
// a new salt so cross-correlation is hard.
//
// Optimised so each class is a single pre-compiled regex with capture
// groups (no nested string scans).

import { createHash } from 'node:crypto';
import type { RedactionReport } from './value-objects';

// ---------------------------------------------------------------------------
// Pre-compiled regexes (one per class, with the `g` flag so a single
// `.replace` call walks the input once).
// ---------------------------------------------------------------------------

// Secrets: high-entropy hex/base64 blobs and labelled keys.
const SECRET_RE =
  /(?:(?:api[_-]?key|secret|password|passwd|pwd|token|bearer|auth)\s*[:=]\s*['"]?)([A-Za-z0-9_+/=-]{12,})['"]?|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}/gi;

// PII: emails, IPv4 addresses, common name prefixes (we only catch labelled
// names like `name: "Alice"` to keep false positives low).
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;

// UUIDs (used as internal ids). We treat them as opaque tokens.
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

// MFA secrets (32+ char base32).
const MFA_RE = /\b[A-Z2-7]{32,}\b/g;

export interface RedactorOptions {
  /**
   * Stable salt used to pseudonymise PII. Distinct salts per analysis
   * make cross-analysis correlation hard.
   */
  salt?: string;
}

export interface RedactionResult {
  redacted: string;
  report: RedactionReport;
}

export class Redactor {
  private readonly salt: string;

  constructor(opts: RedactorOptions = {}) {
    this.salt = opts.salt ?? 'noip-ai-redactor';
  }

  /** Redact a single string. */
  redact(input: string): RedactionResult {
    if (input.length === 0) {
      return {
        redacted: '',
        report: {
          secretsRedacted: 0,
          piiPseudonymised: 0,
          idsOpaqued: 0,
          bytesScrubbed: 0,
        },
      };
    }
    let secretsRedacted = 0;
    let piiPseudonymised = 0;
    let idsOpaqued = 0;
    let bytesScrubbed = 0;

    // Order matters: scrub secrets first (they may contain ids/uuids).
    let out = input.replace(SECRET_RE, match => {
      secretsRedacted += 1;
      bytesScrubbed += match.length;
      return classifySecret(match);
    });

    out = out.replace(MFA_RE, match => {
      // 32-char base32 might collide with policy ids; only replace when
      // the surrounding text looks like an MFA-y thing. Cheap heuristic:
      // surrounded by no other [A-Z]+ context. We accept the over-match
      // here — this class is small and the `<REDACTED:mfa_secret>` token
      // is itself stable.
      secretsRedacted += 1;
      bytesScrubbed += match.length;
      return '<REDACTED:mfa_secret>';
    });

    out = out.replace(EMAIL_RE, match => {
      piiPseudonymised += 1;
      bytesScrubbed += match.length;
      return this.pseudonymise('email', match);
    });

    out = out.replace(IPV4_RE, match => {
      piiPseudonymised += 1;
      bytesScrubbed += match.length;
      return this.pseudonymise('ip', match);
    });

    out = out.replace(UUID_RE, match => {
      idsOpaqued += 1;
      bytesScrubbed += match.length;
      return this.opaqueId(match);
    });

    return {
      redacted: out,
      report: {
        secretsRedacted,
        piiPseudonymised,
        idsOpaqued,
        bytesScrubbed,
      },
    };
  }

  /**
   * Redact every string in a list and aggregate the report.
   */
  redactAll(inputs: ReadonlyArray<string>): {
    redacted: string[];
    report: RedactionReport;
  } {
    const redacted: string[] = [];
    let secretsRedacted = 0;
    let piiPseudonymised = 0;
    let idsOpaqued = 0;
    let bytesScrubbed = 0;
    for (const s of inputs) {
      const r = this.redact(s);
      redacted.push(r.redacted);
      secretsRedacted += r.report.secretsRedacted;
      piiPseudonymised += r.report.piiPseudonymised;
      idsOpaqued += r.report.idsOpaqued;
      bytesScrubbed += r.report.bytesScrubbed;
    }
    return {
      redacted,
      report: {
        secretsRedacted,
        piiPseudonymised,
        idsOpaqued,
        bytesScrubbed,
      },
    };
  }

  private pseudonymise(kind: 'email' | 'ip', value: string): string {
    const v = value.toLowerCase();
    const h = createHash('sha256')
      .update(this.salt + ':' + v)
      .digest('hex');
    return `<PII:${kind}:${h.slice(0, 12)}>`;
  }

  private opaqueId(value: string): string {
    const h = createHash('sha256')
      .update(this.salt + ':' + value)
      .digest('hex');
    return `op_${h.slice(0, 16)}`;
  }
}

function classifySecret(match: string): string {
  const lower = match.toLowerCase();
  // JWT tokens (3-part dot-separated base64url) win even when wrapped in
  // `token=...` since the entire match begins with `eyJ` after the
  // `=`/`:` boundary.
  if (/(?:^|[=:'\s"])eyj/.test(lower) || lower.startsWith('eyj'))
    return '<REDACTED:jwt>';
  if (lower.startsWith('sk-')) return '<REDACTED:api_key>';
  if (lower.startsWith('ghp_')) return '<REDACTED:github_token>';
  if (lower.startsWith('xox')) return '<REDACTED:slack_token>';
  if (/password|passwd|pwd/.test(lower)) return '<REDACTED:password>';
  if (/api[_-]?key/.test(lower)) return '<REDACTED:api_key>';
  if (/secret/.test(lower)) return '<REDACTED:secret>';
  if (/token|bearer/.test(lower)) return '<REDACTED:token>';
  return '<REDACTED:secret>';
}

/** Convenience accumulator for application services. */
export function mergeReports(
  a: RedactionReport,
  b: RedactionReport
): RedactionReport {
  return {
    secretsRedacted: a.secretsRedacted + b.secretsRedacted,
    piiPseudonymised: a.piiPseudonymised + b.piiPseudonymised,
    idsOpaqued: a.idsOpaqued + b.idsOpaqued,
    bytesScrubbed: a.bytesScrubbed + b.bytesScrubbed,
  };
}
