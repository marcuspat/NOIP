# ADR-0009: Multi-factor authentication strategy

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Security
- **Tags:** security, auth, mfa

## Context and Problem Statement

Compliance frameworks (SOC2, ISO27001, HIPAA) mandate MFA for privileged
access. The model already declares MFA fields (`mfaEnabled`, `mfaSecret`,
`mfaBackupCodes`, `MFAMethod = 'totp' | 'sms' | 'email' | 'backup'`) and the
codebase ships `speakeasy` and `qrcode`.

## Decision Drivers

- TOTP as the primary, recovery-friendly factor.
- Backup codes for account recovery.
- Optional SMS / email codes for users who refuse authenticator apps.
- Clear UX for enrolment, verification, and recovery.
- Bound brute-force attack rate with dedicated MFA rate limits.

## Considered Options

1. **TOTP (RFC 6238) primary; backup codes; SMS/email secondary.**
2. **WebAuthn / FIDO2 first** — phishing-resistant.
3. **Push notifications via vendor (Duo, Okta Verify).**
4. **TOTP only, no backup codes.**

## Decision Outcome

**Chosen option:** Option 1 today; **WebAuthn (Option 2) is on the roadmap**
as the preferred phishing-resistant factor for `super-admin` and
`security-admin` roles (separate ADR when implemented).

### Enrolment

1. User initiates MFA enrolment for method `totp`.
2. Server generates a 32-byte secret with `speakeasy.generateSecret`, returns
   `otpauth://` URI rendered as a QR code via `qrcode`.
3. User must verify with one TOTP code before enrolment is committed.
4. Server issues 10 single-use backup codes (Argon2id-hashed); user must
   acknowledge they have stored them.

### Verification

- TOTP window: ±2 steps (`MFA_TOTP_WINDOW=2`).
- SMS / email codes: 6 digits, 5-minute TTL stored in Redis under
  `noip:mfa:<userId>:<method>`.
- Backup codes: single-use; consumed code is marked used and removed from the
  set; below 3 remaining we surface a UI nudge to regenerate.

### Rate limits

| Endpoint | Window | Max | Source |
|----------|--------|-----|--------|
| `/auth/mfa/verify` | 5 min | 10 attempts | `RATE_LIMIT_MFA_*` |
| `/auth/mfa/setup` | 15 min | 5 attempts | `RATE_LIMIT_AUTH_*` |

### Grace period

- Newly enabled MFA policy honours `MFA_GRACE_PERIOD` (7 days default) before
  enforcement, giving users time to enrol.

### Positive Consequences

- Industry-standard primary factor (TOTP) works offline and across devices.
- Backup codes are a reliable recovery path that does not depend on email
  delivery.
- Domain events (`mfa.enabled`, `mfa.verification.failure`,
  `mfa.verification.success`) enable monitoring (DDD-12).

### Negative Consequences / Trade-offs

- SMS is known to be the weakest factor (SIM swapping); we offer it as a
  fallback only and emit elevated-risk audit events on use.
- TOTP is not phishing-resistant; mitigated in future by WebAuthn.

## Pros and Cons of the Options

### TOTP + backup + SMS/email

- 👍 No vendor lock-in; works offline; broad device support.
- 👎 Not phishing-resistant.

### WebAuthn first

- 👍 Phishing-resistant, modern.
- 👎 Hardware/browser support gaps for some user segments today; will be
  added incrementally.

### Vendor push

- 👍 Smooth UX.
- 👎 Vendor lock-in, cost, on-prem deployment friction.

### TOTP only

- 👍 Simple.
- 👎 Lockout risk too high.

## References

- `src/services/auth.service.ts` (MFA enrolment / verification flows).
- `src/types/auth.types.ts:MFAMethod`, `MFASetupResponse`,
  `MFAVerificationRequest`.
- ADR-0016 (rate limits)
