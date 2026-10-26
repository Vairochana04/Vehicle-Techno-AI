# Valuation Techno — How It Works & What To Improve

> Code review + improvement roadmap, written after reading every API route, service, test and frontend
> component in this repo. Findings marked **[verified]** were reproduced against a running instance.

---

## 1. What the product is

A used-vehicle valuation workflow for Indian vehicle loans. A **bank** creates a valuation job for a
loan applicant's vehicle, a nearby **inspector** claims it and inspects the vehicle on-site, the
platform runs **AI damage + fraud analysis**, compares the inspector's manual valuation against the AI
valuation, and either **auto-approves** (variance ≤ 5%) or **escalates to admin audit** (> 5%).
The bank then receives a full report, the applicant a privacy-reduced summary, everyone gets paid,
and the inspector gets rated.

The differentiator promised in the proposal is **fraud suppression** (killfake.ai-style checks on
geotags, timestamps, duplicate images, odometer, chassis) — i.e. *"smart valuation, safer
transactions"*, not just a price estimate.

---

## 2. Architecture

```
Browser (React 18 + Vite, 4 role dashboards)
        │  fetch /api/*  +  WebSocket /ws
        ▼
Node 22 + Express  (apps/api/src)
        │
        ├── routes/       auth · jobs · admin · analytics   (HTTP + zod validation)
        ├── services/     providers.js (VAHAN, IIB, DeepSearch, killfake, damage, cost)
        │                 report.js    (full/summary HTML) + pdfkit PDF
        ├── realtime.js   WebSocket hub, role-targeted publish()
        └── db.js         node:sqlite, 12 tables, seed()
        ▼
SQLite file (apps/api/data/valuation.db) · uploads/ on disk
```

One process, one port (4000), no build step for the backend. Frontend builds to `apps/web/dist` and
the Express app serves it, so the whole portal is a single deployable unit.

**Provider pattern is the best architectural decision in the repo.** Every external system is a
plain function with a stable contract:

```js
verifyVehicle()      → VAHAN + IIB         analyzeDamage()   → YOLOv8 + Mask R-CNN + XGBoost
deepSearchMarketValue() → DeepSearch       analyzeFraud()    → killfake.ai checks
computePlatformScore()  → DT/SVM scoring
```

Swapping in live vendor APIs or a Python FastAPI ML service does not touch routes or UI. This keeps
the demo fully runnable offline while preserving a real integration boundary.

---

## 3. The workflow, phase by phase (what the code actually enforces)

| Phase | Who | Endpoint | What the system enforces |
|---|---|---|---|
| 1 · Job creation | Bank | `POST /api/jobs` | `verifyVehicle()` rejects malformed plates (422). On success: status `BROADCAST`, `SEEKER_FEE_TO_BANK` ledger row, notification to every inspector inside `broadcastRadiusKm`, `JOB_CREATED` WS event |
| 1 · Broadcast | System | — | `eligibleInspectors()` = haversine distance ≤ radius, `status != SUSPENDED`, sorted by rating then distance |
| 1 · Claim | Inspector | `POST /jobs/:id/accept` | Radius + suspension + rating-window guard, then a **single atomic SQL UPDATE** (`WHERE id=? AND status='BROADCAST'`). `changes === 0` → 409. No read-then-write race |
| 1 · Allocation mode | Admin | `PATCH /admin/settings` | `FIRST_COME` (first claim wins) or `RATING_PRIORITY` — during a 15-min window only the top-rated eligible inspector may claim |
| 2 · Inspection | Inspector | `POST /jobs/:id/start` → `/:id/inspection` | Only the assigned inspector. Photos require **≥ 3 images**, each with category, GPS, timestamp, SHA-256. Writes inspection, then pays **₹1,200 exactly once**, then runs the AI pipeline |
| 3 · AI analysis | System | (inside submit) / `POST /:id/analyze` | `analyzeDamage()` → per-panel detections + parts/labor/paint split. `analyzeFraud()` → 6 checks, weighted score 0–100 (duplicate hash 30, odo tamper 30, chassis 30, GPS 25, timestamp 20, metadata 15) |
| 4 · Dual valuation | System | (same) | `AI = (market − damageCost) × (1 − fraudPenalty)`, penalty 5% HIGH / 2% MEDIUM, rounded to ₹500. `variance = |manual − AI| / AI × 100`. **≤ 5 → GREEN**, final = average of the two. **> 5 → RED**, `finalValuation = null` |
| 4 · Audit | Admin | `POST /:id/audit` | `APPROVE` / `SENIOR_REVIEW` (optional manual final) / `RE_INSPECTION` (resets to `BROADCAST`, voids the instant-pay ledger ref, deletes the inspection) |
| 5 · Reports | Any (role-filtered) | `GET /:id/report` · `/report.pdf` | Bank/admin get the full report (dual valuation, damage, fraud, history, evidence). **Loan seeker always gets the summary** — enforced server-side, not by hiding UI |
| 5 · Rating | Seeker | `POST /:id/rate` | 4 dimensions → `seekerScore`; platform score from variance/fraud/completeness; **composite = 0.4 × seeker + 0.6 × platform**. avg < 2 (≥3 ratings) → `SUSPENDED`, < 2.5 → `RETRAINING`, composite ≥ 4.5 → ₹500 bonus |
| 5 · Bank feedback | Bank | `POST /:id/bank-feedback` | Once per job; avg ≤ 2 alerts admins. Deliberately *not* folded into the composite (the formula stays 0.4/0.6 as specified) |
| 6 · Settlement | Bank/Admin | `POST /:id/settle` | Requires `REPORT_DELIVERED`. Three ledger rows: bank→platform (fee), platform commission (20%), provider margin (80%). Idempotency keyed on `(type, jobId, ref)` so money never double-posts |

**State machine:** `BROADCAST → ASSIGNED → INSPECTION_IN_PROGRESS → INSPECTION_SUBMITTED →
(GREEN: REPORT_DELIVERED | RED: AUDIT_REQUIRED) → SETTLED`.

**Real-time:** `realtime.js` publishes `JOB_CREATED`, `JOB_ASSIGNED`, `VALUATION_READY`,
`AUDIT_APPROVED`, `INSPECTOR_RATED`, `SETTLED`, plus a 20-second `MARKET_TICK`, each targeted at
specific roles — so no dashboard needs to poll.

### Things this repo genuinely gets right

1. **Exclusive assignment is atomic** (conditional UPDATE, not check-then-set).
2. **Money is idempotent by `ref`** — the single most important property for a payments ledger.
3. **Pipeline failure compensates** — if AI analysis throws, the inspection, the instant payment and
   the job status are rolled back so an inspector is never paid for a stranded job.
4. **Summary-report privacy is server-side** — the seeker's payload is stripped in `GET /jobs` too,
   not just hidden in the UI.
5. **Every transition writes an audit row**, and the ledger is queryable per role.
6. **Deterministic simulators** (`seededInt`) make the whole workflow testable and reproducible.
7. **22 automated tests** cover the rules that matter: variance boundary, radius, second-accept 409,
   instant-pay-once, re-inspection cycle, seeker privacy, settle-once, suspension.

---

## 4. Findings — what to improve, in priority order

### P0 · Security & money correctness (fix before any real user touches this)

| # | Issue | Evidence | Fix |
|---|---|---|---|
| 1 | **IDOR on `GET /jobs/:id` and `GET /jobs/:id/report[.pdf]`** — any authenticated user can read any job by ID. **[verified]** A second bank account saw an empty job list but fetched another bank's job with `HTTP 200` and the full payload (`seekerEmail`, `loanRef`, `verification`, `ledger`, …) | `routes/jobs.js:77`, `:143` have no ownership check | Add `canAccess(job, user)`: bank → `job.bankId === user.id`; inspector → assigned or `BROADCAST`; seeker → `seekerEmail/Phone` match; admin → all. Apply to every `/:id` route |
| 2 | **Uploaded inspection photos are world-readable** — `express.static` on `/uploads` with random filenames; the URL is the only secret | `app.js:29` | Gate behind `requireAuth` + ownership, or serve short-lived signed URLs. Evidence photos are PII (location, plate, chassis) |
| 3 | **Money stored as SQLite `REAL` (floats)** with `round2` at write time | `db.js` schema | Store **integer paise**; keep a single formatting helper. Float money + 20/80 splits will drift at scale, and `0.1 + 0.2` bugs are silent |
| 4 | **No DB transactions** — settlement writes 3 ledger rows + job status; inspection submit writes inspection + payment + 3 tables. A crash mid-way leaves partial money **[verified: no `BEGIN`/`COMMIT` anywhere]** | `routes/jobs.js` | Wrap multi-write flows in `db.exec('BEGIN IMMEDIATE') … COMMIT` with rollback on throw. Cheap and removes an entire class of bugs |
| 5 | **Default JWT secret ships in code** — `config.jwtSecret` falls back to a known dev string | `config.js:4` | Refuse to boot when `NODE_ENV=production` and `JWT_SECRET` is missing or equal to the default |
| 6 | **CORS is wide open by default** — `origin: process.env.CORS_ORIGIN \|\| true` reflects any origin | `app.js:20` | Default to same-origin in production; require an explicit allowlist |
| 7 | **`POST /jobs/:id/analyze` lets a BANK actor re-run the AI pipeline** on any job — a manipulation vector (re-roll until GREEN, since market jitter is seeded but damage/fraud depend on stored data) | `routes/jobs.js:104` | Admin-only, or bank-only with an audit reason + rate limit |
| 8 | Login rate limiting is an in-process `Map` — resets on restart, useless with >1 instance | `routes/auth.js:10` | Move to Redis/DB-backed counters. Also add per-IP limits on `/upload` and `POST /jobs` |

### P1 · Production readiness

| # | Issue | Fix |
|---|---|---|
| 9 | **No migrations** — schema is `CREATE TABLE IF NOT EXISTS` + manual edits; any column change breaks existing DBs | Add numbered SQL migrations with a `schema_version` table, or Drizzle/Prisma |
| 10 | **No pagination & N+1 queries** — `GET /jobs` maps `detail()` over every job, and `detail()` runs ~6 queries per job | `?limit&offset` + `?status=` filters; batch the inspector/valuation lookups. Fine for a demo, times out at ~10k jobs |
| 11 | **SQLite is single-node** — WAL helps but writes serialize | Keep SQLite for demo; move to Postgres behind the existing `db.js` access layer before multi-tenant use |
| 12 | **No CI/CD, Dockerfile, linting, formatting or type checking** **[verified: none present]** | GitHub Actions: `npm ci && npm test && npm run build` on every PR; ESLint + Prettier; JSDoc types or migrate to TypeScript; multi-stage Dockerfile |
| 13 | **Observability is `console.log`** | Structured JSON logs (pino), request IDs, `/api/health` that checks DB + upload dir, error tracking (Sentry), and metrics for job throughput / RED-rate / settle latency |
| 14 | **Notifications are DB rows only** — no push, email or SMS, no retry | Wire FCM/WhatsApp Business (inspectors live on mobile), with a delivery-status column and exponential backoff |
| 15 | **No backup/restore story** for a DB that holds money | Scheduled `sqlite3 .backup` + uploads archive, documented restore drill |
| 16 | **Uploads have no MIME/extension whitelist or image validation** (`multer({ dest, limits })` only) | Accept `image/jpeg|png|webp` + PDF docs, verify magic bytes, re-encode images, cap dimensions, strip EXIF *after* hashing |

### P2 · Product depth (this is where the proposal's promise is thin)

| # | Issue | Fix |
|---|---|---|
| 17 | **The "AI" is a deterministic simulator, not vision.** `analyzeDamage()` invents dents from `seededInt(job.id, image.category, index)` — it never looks at pixel data. Change a photo's category and the "detection" changes | Keep the contract, implement it for real: an `AI_PROVIDER=http` mode calling a Python FastAPI service (YOLOv8/SegFormer + XGBoost cost model) on the uploaded file. This is the single highest-value upgrade for credibility with a lender |
| 18 | **PDF report does not embed the photos** — it lists filename/GPS/timestamp rows, so "annotated geotagged images" isn't literally true | Compose annotated images (bbox + label + confidence + geotag burn-in) into the PDF with pdfkit; store thumbnails alongside uploads |
| 19 | **Re-inspection deletes evidence** and mutates the ledger ref (`instant-pay-void`), which breaks ledger immutability | Version inspections (`inspection_version`), keep history, and model the void as a *new* `INSPECTOR_PAY_VOID` ledger row (append-only) |
| 20 | **No SLA / expiry / escalation** — a `BROADCAST` job can sit forever; the rating-priority window expires but nothing re-broadcasts | Job TTL with auto-expand radius, then escalate to admin; reminder notifications; `CANCELLED` status is declared but unreachable — add a real cancel/withdraw flow |
| 21 | **No inspector trust layer** — no KYC, no selfie/attendance at the vehicle, no check that the device is at the vehicle | Optional selfie + arrival geo-fence check (`< 200 m`), Aadhaar/PAN KYC, device fingerprint in the audit log |
| 22 | **Offline support is only localStorage drafts** — no service worker, manifest or queue, so a dead zone loses the submission | Real PWA: service worker cache, IndexedDB queue with background sync, idempotent submit keys |
| 23 | **No i18n** — English only, in a market where inspectors and applicants are Tamil/Hindi speakers | i18n framework + `ta`, `hi` locales for the inspector and seeker views first |
| 24 | **No maps/ETA** — the "live broadcast map" is a styled panel, not a map | Google/Mapbox for real markers, travel time and radius rings; ETA drives the SLA timer |
| 25 | **Frontend is one 237 KB bundle** with no UI tests or error boundary | Route-level `React.lazy` code splitting, an error boundary, Playwright smoke test for the core 5-role flow |

### P3 · Moat & business (after the platform is trustworthy)

26. **Fraud network effect** — keep a platform-wide `imageHash` / `chassis` / `regNumber` index. A photo
    reused across two banks, or a chassis seen in three claims, is a far stronger signal than any
    single-job check. This is the actual killfake-style moat and it needs no new vendor.
27. **Lender integrations** — webhook/API push of the final report into the bank's LOS, bulk job upload
    (CSV), and a bank-facing dashboard showing portfolio risk rather than one job at a time.
28. **Pricing engine** — commission is hardcoded 20% and the fee default ₹2,500; make it per-bank,
    per-vehicle-segment, and add GST invoicing with a downloadable statement.
29. **Dispute & refund flow** — no way to challenge a valuation after delivery. Add a dispute window,
    evidence upload, and a ledger reversal path (append-only).
30. **DPDP Act 2023 compliance pack** — consent capture, data-retention policy, right-to-erasure,
    PII inventory, and a tamper-evident audit log (hash chain) — expected by every lender's diligence.
31. **Mobile inspector app** (React Native/Expo) reusing the same API, with camera-first capture and
    background upload.
32. **EV/battery-specific valuation** — battery health is the whole value of a used EV; a state-of-health
    field plus a residual-value model is a clear differentiator in 2026 India.

---

## 5. Honest one-line summary

The **workflow, state machine, money rules, role isolation and real-time layer are genuinely real and
tested** — this is a credible product skeleton, not a mock. The gaps are (a) a handful of **P0 access
control and money-precision bugs**, (b) **no production plumbing** (CI, migrations, logs, Postgres),
and (c) the **"AI" is simulated**, which is fine for a demo but is the first thing a technical lender
will probe.

Suggested order: **P0 (≈1 week) → CI + migrations + Postgres (≈2 weeks) → real AI provider + PDF
images (≈3 weeks) → PWA/i18n/maps → moat features.**
