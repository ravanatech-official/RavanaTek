# Security Summary

Ravana Tech (`ravanatek.web.app`, Firebase project `ravanatek`, Cloud Firestore database `ravanatek-db`) has been hardened across client, edge hosting, Express runtime, and Cloud Firestore database rules layers while preserving the 5-screen interactive deck and locked desktop Home hero layout.

## 1. Content Security Policy (CSP) & Script Externalization
- Eliminated inline `<script>` execution and inline `onload`/`onerror` HTML event handlers across `index.html`, `projects.html`, `services.html`, `privacy.html`, `terms.html`, `security.html`, `data-policy.html`, and `404.html`.
- Extracted inline client modules into `assets/js/firebase-init.js`, `assets/js/archive-nav.js`, and `assets/js/services-deck.js`, allowlisted in `scripts/build-public.mjs`.
- Removed `'unsafe-inline'`, `'unsafe-eval'`, `https://unpkg.com`, and `https://cdn.tailwindcss.com` from global `script-src` in `firebase.json`, `server.js`, and `server.ts`, using `'self' 'sha256-ggi9dVQEFdAqcDjQHp/SwxuPocrSA4HIBzSTKRVhAa8=' https://www.gstatic.com https://www.googletagmanager.com` (narrowly permitting only the static JSON Firebase import map) plus `object-src 'none'`.
- Preserved standalone conceptual previews via scoped route headers on `/conceptual projects/**` and `/conceptual-projects/**` rendered inside `referrerpolicy="no-referrer"` preview frames.

## 2. DOM & Client Storage Hardening
- Replaced unsafe `innerHTML` string interpolation in `assets/js/main.js` (`formFeedback` & `waLink`), `main.js` (`appendSwarmLog`, MDR/pipeline tables, radar cards), and `assets/js/gallery.js` (`safeCssColor()`, `safeBoxIcon()`, `safeImagePath()`, preview hash regex check, safe button text updates).
- Hardened `localStorage.getItem('ravana_user_real_cv')` parsing in `main.js` with plain-object checks and strict key allowlisting (`heroName`, `heroRole`, `summary`, `exp1Title`, `exp1Period`, `exp1Bullets`) to block client-side prototype pollution.

## 3. Express Runtime & API Hardening (`server.js` & `server.ts`)
- Unified security headers across both servers and `firebase.json`: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `X-Permitted-Cross-Domain-Policies: none`, `X-DNS-Prefetch-Control: off`, `Origin-Agent-Cluster: ?1`, expanded `Permissions-Policy`, and `Cache-Control: no-store` on `/api/*`.
- Added strict `POST /api/*` checks rejecting non-JSON/form `Content-Type` (`415`), untrusted `Origin` headers (`403`), malformed JSON bodies (`400`), oversized payloads (`413`), and `__proto__`/`constructor`/`prototype` keys (`400`).
- Fixed prototype property lookup on `POST /api/document-sim` via `Object.prototype.hasOwnProperty.call(samples, sampleId)` and synced all 4 document templates (`submittal`, `invoice`, `hvac`, `ncr`) across `server.js` and `server.ts`.
- Stripped internal error messages (`err.message`) from `/api/conceptual-projects` and `/api/health` responses.
- Expanded `FORBIDDEN_PATH_PATTERN` to block `firebase-blueprint.json`, `security_spec.md`, `walkthrough.md`, `DRAFT_*`, `*.rules`, `.github`, and source/config files while keeping `/.well-known/security.txt` reachable.

## 4. Ultra-Strong Cloud Firestore Rules & Schema (`ravanatek-db`)
- Defined formal schemas in `firebase-blueprint.json` (`Inquiry` and `AdminUser`) and security invariants in `security_spec.md`.
- Upgraded `firestore.rules` with a fail-closed top-level `match /{document=**} { allow read, write: if false; }`, explicit `isValidId()` (`^[A-Za-z0-9_-]+$`, `<= 128` chars), `admins/{adminId}` write lockdown (`allow create, update, delete: if false;`), verified-admin MFA/email check (`request.auth.token.email_verified == true`), write-once schema-validated `/inquiries/{inquiryId}` creation (`keys().hasOnly(...)`, `keys().hasAll(...)`, regex email check, `status == 'new'`, `createdAt == request.time`), admin status-only updates (`diff().affectedKeys().hasOnly(['status', 'updatedAt'])`), unconditional `delete: if false;`, and explicit nested subcollection denial.

## 5. Technical SEO & Metadata Integrity
- Replaced dead `Ravana.webp` OpenGraph/Twitter references across all HTML pages with live `https://ravanatek.web.app/assets/img/ravana_banner_1791448914226.jpg` (`1376x768`, verified HTTP `200`).
- Standardized canonicals, `hreflang`, `robots` preview directives, preconnect hints, updated `robots.txt` / `sitemap.xml`, and `@graph` Schema.org JSON-LD across all pages.

## Dependency Audit Note
- `npm audit --audit-level=moderate` previously flagged 4 transitive high-severity advisories inside `@grpc/grpc-js <=1.13.5` (pulled transitively by `firebase@13.0.0`). Not blindly downgraded to preserve compatibility with `firebase-admin` / `firebase@13.0.0`; tracked for next SDK minor/major upgrade cycle.

---

## PoC Verification

- **CSP Violation / Inline Script Block Verification (Chromium Headless)**: Loaded `/`, `/projects`, `/services`, `/privacy`, `/terms`, `/security`, and `/data-policy` against `server.js` serving `public-build/`. Confirmed zero console errors, zero CSP errors, working importmap & Firebase module load, 50-project bento grid & `no-referrer` modal preview, intact `830px x 600px` desktop Home hero layout, and working `1-scroll = 1-screen` wheel navigation.
- **API Prototype Pollution & Input Validation PoC (`test/public-exposure.test.mjs`)**: Verified both `server.js` and `server.ts` return `400` for `POST /api/document-sim` with `sampleId: "constructor" | "__proto__" | "toString" | "valueOf"`, return `400` for `POST /api/inquiry` containing raw `{"__proto__": ...}`, `constructor`, or malformed JSON, return `415` for `text/plain`, and return `403` for untrusted `Origin: https://evil-attacker.invalid`.
- **Private Artifact Exposure PoC (`test/public-exposure.test.mjs`)**: Verified `GET` and `HEAD` against `/firestore.rules`, `/firebase-blueprint.json`, `/security_spec.md`, `/walkthrough.md`, `/DRAFT_firestore.rules`, `/data/leads-db.json`, `.env`, and traversal aliases return HTTP `404` non-HTML JSON on both servers and are excluded from `public-build/`.
- **Firestore Rules Structural & Dirty Dozen Verification (`test/firestore.rules.test.mjs`)**: Verified `ravanatek-db` parity across `firebase-applet-config.json`, `firebase-blueprint.json`, and `firebase.json`, balanced rule syntax, fail-closed catch-all, admin write lockdown, and `request.time` / schema enforcement invariants. *(Note: Local JVM Firestore emulator could not run in this container because `java` is unavailable; deploy rules explicitly to `ravanatek-db` via Firebase CLI before go-live.)*
