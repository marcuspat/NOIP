# ADR-0008: Multi-channel MFA — TOTP primary, SMS/email fallback, backup codes

- **Status:** Accepted
- **Date:** 2026-05-08
- **Tags:** security, authentication

## Context

Operators of a security platform must not be the weak link. Compliance
frameworks NOIP itself reports on (SOC2, ISO27001) require MFA for
privileged access. We need MFA that:

1. Defaults to a phishing-resistant primary factor.
2. Accommodates users without smartphones or with lost devices.
3. Has a recovery path that does not require operator intervention.

## Decision

NOIP supports three MFA channels and requires at least one:

- **TOTP (RFC 6238)** via `speakeasy ^2.0.0`. QR-code enrolment uses the
  `qrcode` package. This is the **default** and the recommended channel.
- **Email OTP** — a 6-digit code with a 10-minute TTL, delivered via the
  `nodemailer` SMTP transport in `src/utils/auth/email.service.ts`.
- **SMS OTP** — same shape as email; provider integration is pluggable
  but disabled by default in dev.

All users are issued **10 single-use backup codes** at MFA enrolment,
hashed with Argon2id at rest. Consumed codes are deleted; if a user has
fewer than 3 remaining, the next successful login warns them.

Enrolment, challenge and verification are all gated by an active session
(JWT) so the MFA flow cannot be reused across users.

## Alternatives considered

- **TOTP only.** Cleanest but excludes users who lose their device with
  no backup codes — unacceptable for an enterprise platform.
- **WebAuthn / FIDO2 only.** Phishing-resistant and our long-term goal,
  but rolling it out as the *only* channel today excludes too many
  users. Tracked as a follow-up; will be added as a fourth channel.
- **SMS-only.** Vulnerable to SIM-swap; never acceptable as primary.

## Consequences

### Positive
- TOTP gives strong, offline, vendor-neutral MFA.
- Backup codes self-serve recovery without an admin escalation.
- Channels are pluggable — adding WebAuthn later is incremental.

### Negative / costs
- Three channels are three integrations to maintain and test.
- SMS is most-attacked surface; we make it explicit in the UI that
  TOTP is preferred.

### Risks and mitigations
- *Email account compromise pivots into NOIP.* Email OTP is documented
  as a *fallback*, not the steady state.
- *SIM-swap attacks on SMS.* Mitigated by rate-limiting and by emitting
  a high-severity `SecurityEvent` on every SMS-OTP success that occurs
  from a new device fingerprint.

## References

- `src/services/auth.service.ts` — enrolment, challenge, verify.
- `src/utils/auth/mfa.util.ts` — TOTP/QRcode helpers.
- `src/utils/auth/email.service.ts` — email OTP transport.
- `src/models/user.model.ts` — `mfaEnabled`, `mfaSecret`, `backupCodes`.
