# ADR-0007: Argon2id for password hashing (with bcrypt legacy support)

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Security, Platform engineering
- **Tags:** security, auth, crypto

## Context and Problem Statement

User passwords must be stored using a memory-hard, slow KDF that resists GPU
and ASIC attacks. The current `User` model uses bcrypt
(`src/models/user.model.ts:bcrypt.hash(this.passwordHash, 12)`); however
`package.json` already includes `argon2 ^0.44`, indicating intent to migrate.

## Decision Drivers

- OWASP and NIST 800-63B recommend Argon2id as the preferred KDF.
- We need a strategy that allows existing bcrypt hashes to be migrated lazily
  on next successful login, without forcing a global password reset.
- Tunable cost parameters that scale with hardware over time.

## Considered Options

1. **Argon2id with lazy migration from bcrypt.**
2. **Stay on bcrypt** indefinitely.
3. **scrypt** as a middle ground.
4. **PBKDF2** (FIPS-friendly).

## Decision Outcome

**Chosen option:** **Argon2id** for new and rehashed credentials.

- New users: hash with Argon2id.
- Existing bcrypt users: on successful login, transparently rehash with
  Argon2id and update `passwordHash`.
- Password storage uses an **encoded hash** that includes algorithm, version,
  cost parameters, salt, and digest. The verifier dispatches to bcrypt or
  Argon2 based on the prefix (`$2a$`, `$2b$`, `$argon2id$…`).

Initial Argon2id parameters (subject to periodic re-tuning):

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `type` | `argon2id` | Hybrid resistance to side-channel + GPU. |
| `memoryCost` | 64 MiB | Within container limits, well above 19 MiB OWASP floor. |
| `timeCost` | 3 | OWASP minimum. |
| `parallelism` | 1 | Single-process workers. |
| `hashLength` | 32 bytes | 256-bit digest. |

### Positive Consequences

- Modern, OWASP-recommended KDF.
- Lazy migration avoids password resets and observability/UX disruption.
- Tunability via configuration; we can raise costs as hardware improves.

### Negative Consequences / Trade-offs

- Higher CPU/memory cost per login (acceptable; logins are rate-limited).
- Two code paths (bcrypt + argon2) until the bcrypt cohort fully drains.

## Pros and Cons of the Options

### Argon2id

- 👍 OWASP / NIST recommended.
- 👍 Memory-hard.
- 👎 Slightly higher RAM during verification.

### Bcrypt

- 👍 Battle-tested, ubiquitous.
- 👎 Not memory-hard; password length is capped at 72 bytes; less resistant to
  GPU attacks.

### scrypt

- 👍 Memory-hard.
- 👎 Less ergonomic library support than Argon2 in Node.

### PBKDF2

- 👍 FIPS-approved.
- 👎 Not memory-hard; effectiveness erodes against modern GPUs.

## References

- OWASP *Password Storage Cheat Sheet* (2024).
- `node-argon2` library — `^0.44`.
- `src/services/auth.service.ts`
- ADR-0006 (JWT)
