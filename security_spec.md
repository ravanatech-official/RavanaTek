# Firestore Security Specification (`ravanatek-db`)

## 1. Architecture & Multi-Site Isolation
- **Project ID**: `ravanatek`
- **Dedicated Named Database**: `ravanatek-db` (configured in `firebase.json` and `firebase-applet-config.json`)
- **Security Model**: Fail-closed zero-trust schema and access enforcement.

## 2. Data Invariants
1. **Default-Deny Baseline**: Every unconfigured collection, nested subcollection, and document defaults to `allow read, write: if false;`.
2. **Document ID Hygiene**: All document IDs (`{inquiryId}`, `{adminId}`) must satisfy `isValidId(id)` (`1..128` chars, `^[A-Za-z0-9_-]+$`), blocking slash injection, path traversal, and oversized key abuse.
3. **Public Lead Intake (`/inquiries/{inquiryId}`)**:
   - **PII Protection**: Unauthenticated and non-admin callers can **never** `get`, `list`, `update`, or `delete` inquiries.
   - **Strict Key Allowlist**: `create` accepts ONLY `name`, `email`, `system`, `message`, `createdAt`, `clientTimestamp`, `source`, `status` (`hasOnly` + `hasAll`).
   - **Field Bounds & Formats**:
     - `name`: string, `1..200` chars
     - `email`: string, `5..200` chars, strict RFC-safe regex `^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$` (disallows whitespace, newlines, header injection)
     - `system` (optional): string, `1..200` chars
     - `message`: string, `1..5000` chars
     - `source` (optional): string matching `^[a-z0-9_:-]{1,64}$`
     - `clientTimestamp` (optional): ISO-8601 UTC timestamp matching `^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$`, max `32` chars
   - **Anti-Tampering & Server Truth**:
     - `status` MUST equal `'new'` on creation.
     - `createdAt` MUST equal `request.time` (blocks forged backdated/future timestamps).
4. **Admin RBAC & Audit Immutability (`/admins/{adminId}` & Admin Triage)**:
   - `/admins/{adminId}` has `allow write: if false;` (admins can only be provisioned out-of-band via Firebase Admin SDK / Console, blocking client-side privilege escalation).
   - `isVerifiedAdmin()` requires `request.auth != null && request.auth.token.email_verified == true` and an existing `/admins/$(request.auth.uid)` record with `role == 'admin'`.
   - Verified admins can read inquiries and transition ONLY `status` (`'new' | 'reviewed' | 'archived'`) + `updatedAt == request.time`. Core submission fields (`name`, `email`, `system`, `message`, `createdAt`, `source`, `clientTimestamp`) are strictly immutable.
   - Client-side `delete` on `/inquiries/{inquiryId}` and `/admins/{adminId}` is unconditionally `false`.

## 3. Dirty Dozen Attack Verification Vectors
| # | Threat Vector | Target | Expected Decision |
|---|---|---|---|
| 1 | Unauthenticated `get` / `list` PII scraping | `/inquiries/{id}` | **DENY** |
| 2 | Unauthenticated `update` or `delete` | `/inquiries/{id}` | **DENY** |
| 3 | Non-admin signed-in user reading inquiries | `/inquiries/{id}` | **DENY** |
| 4 | Self-promotion write to admin registry (`role: 'admin'`) | `/admins/{uid}` | **DENY** |
| 5 | Extra field injection (`isAdmin: true`, `__proto__`, `role`) | `/inquiries/{id}` create | **DENY** (`hasOnly`) |
| 6 | Missing required field (omitting `email`, `status`, or `createdAt`) | `/inquiries/{id}` create | **DENY** (`hasAll`) |
| 7 | Type juggling (`name: 123`, `message: ['x']`, `status: null`) | `/inquiries/{id}` create | **DENY** |
| 8 | Client-forged `createdAt` timestamp (not `request.time`) | `/inquiries/{id}` create | **DENY** |
| 9 | Workflow bypass (`status: 'archived'` or `'reviewed'` on create) | `/inquiries/{id}` create | **DENY** |
| 10 | Volumetric / storage DoS (`message` = 6000 chars, `name` = 500 chars) | `/inquiries/{id}` create | **DENY** |
| 11 | Email header injection / invalid email / malformed `source` or `clientTimestamp` | `/inquiries/{id}` create | **DENY** |
| 12 | Oversized or malformed `{inquiryId}` / nested subcollection `/inquiries/{id}/notes/1` | `/inquiries/...` | **DENY** |
