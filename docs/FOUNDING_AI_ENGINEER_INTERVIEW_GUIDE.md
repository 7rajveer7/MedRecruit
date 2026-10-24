# MedRecruit: Beginner’s Architecture and Interview Guide

This guide explains the project as it exists in this repository and helps you discuss it honestly in an interview for a Founding AI Engineer role. You do not need to pretend you built a production ATS integration platform: this project is a local MVP. Your strongest story is that you made a small, understandable recruiting workflow, made shortlist decisions explainable, kept AI in an assistive role, and can clearly describe what must change before real customers or candidate data are involved.

> **Accuracy rule:** distinguish “implemented,” “prototype,” and “next step.” In particular, the current app does not connect to a customer ATS, does not verify medical licenses, and does not make a hiring decision.

## 1. What the product does

MedRecruit is a local physician-recruiting ATS prototype. A recruiter can:

1. Recruiters create an account and set up a workspace; doctors have a separate signup and profile.
2. Recruiters add open roles with specialty, location, notes, and required license states; doctors can browse them in the public portal.
3. Doctors upload a resume to their profile and apply to roles; each application creates a recruiter-owned candidate record linked to that role. Recruiters can also add candidates manually.
4. Recruiters move applicants through recruiting stages; doctor dashboards reflect statuses such as Applied, Under consideration, Interview, Offer, Rejected, and Expired. Closing a role expires its applications.
5. Recruiters build a shortlist with a visible score, reasons, and information gaps.
6. Recruiters can draft a factual resume summary or role-specific screening questions, using an optional LLM.
7. Recruiters can save a screen meeting. The doctor dashboard refreshes application and meeting information every 20 seconds; configured Google Calendar events invite the doctor by email.

The distinguishing product choice is **evidence-first matching**. The system shows why a profile matched and what is missing. The score is a prioritization aid; it is not proof of licensure, clinical competence, or candidate quality.

## 2. Architecture at a glance

```mermaid
flowchart LR
  Recruiter[Recruiter in browser] -->|Next.js / React| Web[apps/web]
  Web -->|JSON REST + HTTP-only session cookie| API[Fastify API]
  API -->|SQL queries / export on write| DB[(sql.js SQLite file)]
  API -->|Resume bytes| Files[(storage/resumes)]
  API -. optional .env key .-> LLM[OpenAI API]
  API -. optional Google OAuth .-> Google[Google Calendar API / Meet]
```

It is a **monorepo** because the frontend and backend live in one Git repository and share one top-level npm workspace. At runtime, the web app and API are separate processes on local ports 3000 and 4000. Within the API, the current design is a **modular monolith**: one service owns authentication, recruiting records, resume handling, matching, AI assistance, and meetings. It is intentionally simpler than a collection of microservices.

## 3. File-by-file tour

| File | What it does | Beginner reading tip |
|---|---|---|
| [`package.json`](../package.json) | Root npm workspace and commands for starting/building both apps. `concurrently` starts API and web together. | A workspace lets each app have its own package while sharing one repo and install. |
| [`apps/api/package.json`](../apps/api/package.json) | API dependencies and start/build scripts. | Dependencies are libraries the API calls into; Fastify is the server, `sql.js` is storage, `bcryptjs` hashes passwords. |
| [`apps/web/package.json`](../apps/web/package.json) | Frontend dependencies and Next.js scripts. | Next.js runs the React UI and its development/build tooling. |
| [`apps/api/src/index.ts`](../apps/api/src/index.ts) | Main backend entry point: environment setup, database schema/helpers, auth, REST routes, shortlist algorithm, AI and Google integrations, server startup. | Read top to bottom once; then find `app.post(...)`/`app.get(...)` for each route. It is currently one large file, not a layered service architecture. |
| [`apps/api/src/pdf-parse.d.ts`](../apps/api/src/pdf-parse.d.ts) | Small TypeScript declaration for the PDF parser package’s return type. | A type declaration tells TypeScript how to understand a library. It does not implement PDF parsing. |
| [`apps/api/tsconfig.json`](../apps/api/tsconfig.json) | API TypeScript compiler settings. Strict checking is enabled and build output goes to `dist`. | `strict` catches many accidental type mistakes before runtime. |
| [`apps/web/app/page.tsx`](../apps/web/app/page.tsx) | Recruiter client application: login/signup, onboarding, roles, candidates, shortlist, AI drafts, and meetings. | It is a “client component” (`"use client"`) because it uses React state, event handlers, and browser APIs. It currently contains most recruiter screens in one file. |
| [`apps/web/app/doctor/page.tsx`](../apps/web/app/doctor/page.tsx) | Doctor portal: separate signup/login, public open roles, profile/resume upload, apply action, application status dashboard, and meeting details. | The `/doctor` route is created by placing `doctor/page.tsx` inside Next.js `app/doctor`. It polls application updates while open. |
| [`apps/web/app/doctor/doctor.css`](../apps/web/app/doctor/doctor.css) | Responsive visual styles for the doctor portal. | It separates the applicant-facing visual system from the recruiter UI styles.
| [`apps/web/app/globals.css`](../apps/web/app/globals.css) | Global styles and responsive layouts for the UI. | CSS controls presentation; it does not perform business rules or data persistence. |
| [`apps/web/app/layout.tsx`](../apps/web/app/layout.tsx) | Next.js root layout, metadata, and global stylesheet import. | This wraps the page and sets the browser tab title/description. |
| [`apps/web/tsconfig.json`](../apps/web/tsconfig.json) | Frontend TypeScript and Next.js compiler settings. | `moduleResolution: bundler` is configured for frontend imports. |
| [`.env.example`](../.env.example) | Safe template of supported environment-variable names; blank optional credentials. | Copy to `.env` for local setup; never put actual keys in this tracked example. |
| [`.gitignore`](../.gitignore) | Keeps `.env`, local database, uploads, dependencies, and build output out of Git. | `git status` should not show secrets or candidate files. Verify before committing. |
| [`README.md`](../README.md) | Current setup instructions, scope, API route list, and known product limitations. | Use this as the operator’s quick-start; this guide is for learning and interviews. |

The local SQLite database is written under `data/medrecruit.sqlite`, and uploaded resume files go under `storage/resumes/`. Those are runtime data directories, not source code. They are ignored by Git.

### One repository hygiene item to know

The web package currently declares `@medrecruit/shared`, and the lockfile has a workspace link for it, but there is no `packages/shared` source directory in the checked-in project and the page defines its own types. It is an unused/stale workspace reference to clean up or implement. Do not describe shared types as an existing feature. A natural next cleanup is either remove that dependency/link or add the real shared package and import API contracts from it.

## 4. Follow one request through the app

### Example: sign up

1. The form in `apps/web/app/page.tsx` collects name, email, and password.
2. `submitAuth` sends JSON to `POST /api/auth/signup` using the `api` helper. `credentials: "include"` allows the browser to send/receive the session cookie.
3. Fastify validates fields, hashes the password with bcrypt, inserts a user row, creates a signed JWT, and sends it in an HTTP-only cookie.
4. The frontend stores the returned safe user object in React state and shows onboarding.
5. The onboarding form posts the workspace name and recruiter role to `POST /api/onboarding`.
6. The API uses the session cookie to identify the user and persists the onboarding fields.

The database stores a password hash, not the original password. `cleanUser` removes the hash before a user object is sent to the browser. The JWT identifies a user; the `requireAuth` hook rejects protected requests without a valid session.

**Debugging example you can use:** a signup bug once returned HTTP 500 even though the row had been inserted. Logging showed that the user lookup happened after `persist()`, and the `last_insert_rowid()` value was no longer usable after exporting the sql.js database. The fix captures the new ID immediately after the insert and before persistence. The same create-then-persist pattern was corrected for jobs and candidates. The lesson: follow the data through each step and inspect server logs; a successful database write does not guarantee the whole HTTP request completed successfully.

### Example: shortlist

1. The recruiter selects a role and presses “Build evidence shortlist.”
2. The browser posts to `POST /api/jobs/:id/shortlist`.
3. The API checks that the requested job belongs to the signed-in user, then considers that user’s candidates.
4. It computes a deterministic score from recorded fields and resume text; it collects human-readable `reasons` and `gaps` alongside the score.
5. Specialty and any configured license-state requirement are eligibility gates. Results sort eligible candidates first and then by score.
6. The API stores the latest result and returns it; the UI shows evidence and follow-up gaps.

Current score inputs are specialty (35 points), license evidence (25), location (15), availability recorded (10), resume keyword evidence (5), and experience (up to 10). Exact specialty matching and a simple location substring are used. The “license evidence” consists only of state strings the recruiter entered; the app has no licensing-board integration or verification. That distinction is essential when describing this feature.

## 5. Technology choices and trade-offs

| Choice | Why it fits this prototype | Trade-off / what changes with real customers |
|---|---|---|
| TypeScript | Types make API payloads and UI models easier to reason about; strict mode catches common mistakes. | Types alone do not validate untrusted HTTP input at runtime. Add schemas (for example, JSON Schema/Zod) and a shared contract package. |
| Next.js + React | Familiar component-based UI with a quick local workflow and an easy path to a deployed web client. | Most of this UI is in one client component. Split screens and shared form/components as workflow complexity grows; consider server rendering only where it helps. |
| Fastify | Small, fast Node API with plugins for cookies, CORS, JWT, and multipart uploads. | Routes and business logic currently share one file. Extract route modules and domain services before the code becomes difficult to test or own. |
| REST/JSON | Clear request/response boundaries between browser and API; easy to inspect with curl and browser devtools. | Version contracts, validate inputs, paginate growing lists, and standardize error responses. |
| npm workspaces / monorepo | One clone and one install for UI and API; makes coordinated changes convenient. | Apps still need clear boundaries and separately managed deployment/configuration. The unused shared package reference should be resolved. |
| sql.js (SQLite compiled to WebAssembly) | No database server or native build tool; self-contained local setup for a demo. | This code exports the whole database file on writes. It is a local prototype strategy, not a robust multi-user production database setup. For a customer pilot, choose a server-backed database, migrations, transactions, backup/restore, and connection/pooling strategy. |
| Local resume files | Simple local persistence and no object-storage account needed to demonstrate intake. | No malware scan, encryption-at-rest policy, retention workflow, or production access controls. Production should use private object storage, short-lived access, scanning, and deletion/audit policies. |
| Cookie-based JWT session | Browser can authenticate API calls without putting a bearer token in JavaScript storage. Cookie is HTTP-only, with local CORS credentials configured. | Production needs secure deployment, CSRF review, key rotation, rate limits, session revocation strategy, account recovery, and tests. Current secret is one local `.env` value. |
| Deterministic shortlist logic | Reproducible and explainable; same input data produces the same result. Recruiters can see evidence and gaps. | Exact string matching is simplistic and manually entered data can be wrong. Better parsing and normalization should surface source-backed evidence and uncertainty—not hide them behind an opaque score. |
| Optional LLM drafts | AI can reduce repetitive writing while deterministic fallback text keeps the demo usable with no API key. | Current LLM calls are direct, synchronous requests with basic fallbacks. Production needs data minimization, prompt-injection defenses, structured output validation, model/version tracking, evaluation, latency/cost handling, and clear user review. |
| Google Calendar API (optional) | OAuth refresh-token flow can create a calendar event and request a Meet conference. | This is a single local credential configuration, not a customer-specific integration. A fallback `meet.google.com/new` is only a quick-join page: it does not mean a meeting or unique room was scheduled. |
| Fastify logs | The server enables structured request logs, useful for local debugging. | No metrics, traces, alerting, dashboards, or agent-run audit trail are configured. |

### Architecture patterns and vocabulary

- **Monorepo:** a single Git repository contains related packages/apps.
- **Workspace:** npm manages those packages together from the root `package.json`.
- **Modular monolith:** one backend application with domain areas; simpler to develop/deploy than microservices. As the team grows, split by responsibility only when ownership, scale, or reliability needs justify it.
- **REST endpoint:** a URL plus an HTTP method expresses an operation, such as `GET /api/jobs` to read roles or `POST /api/jobs` to create one.
- **Middleware/pre-handler:** code Fastify runs before a handler; here it verifies authentication for protected endpoints.
- **Persistence:** keeping data after the process exits; here SQLite bytes and resume files are stored locally.
- **Idempotency:** retrying an operation should not accidentally create duplicates. The shortlist uses a unique `(job_id, candidate_id)` and upsert; external ATS sync should use provider IDs and idempotent upserts too.
- **Human-in-the-loop:** a person reviews and owns consequential outcomes. AI suggestions and match signals should support, not replace, recruiter judgment.
- **Observability:** logs, metrics, traces, and alerts that explain what the system is doing and when it fails.

## 6. What is implemented, and what is only a next step

| Area from the job description | In this project today | Credible next engineering step |
|---|---|---|
| Jobs/candidates/assignments/agent runs | Jobs and candidates exist; there is no assignment model or durable agent-run model. | Define assignment ownership/status and an `agent_runs` record with input references, status, output, model/prompt version, timestamps, and error details. |
| ATS integrations | No external ATS connector, sync, webhook, or polling exists. The local doctor portal does create a candidate and application in MedRecruit’s own database. | Build one narrow connector behind an adapter interface; support OAuth, pagination, rate limits, cursor sync, idempotent upsert, retry/backoff, webhook verification, and reconciliation. Start read-only and prove mapping quality before writing back. |
| Recruiter and doctor views | Local UI includes recruiter roles/candidates/shortlist/meetings and doctor applications/profile/status/meeting views. Doctor status refresh uses 20-second polling. | Add saved filters, bulk actions with safeguards, candidate detail/history, assignment ownership, and accessible keyboard-friendly workflows. |
| Structured AI screening | Draft questions and factual summaries only. The app does not conduct an automated interview or score a voice/video screen. | Start with recruiter-approved question templates and structured note extraction; retain source quotes, schema validation, and reviewer edits. Do not auto-reject candidates. |
| Agent platform | No autonomous agent loop or tool execution framework. | Model an explicit workflow with approved tools, scoped permissions, timeouts, retry policy, run logs, and a human approval point. Keep early versions narrow and observable. |
| Instrumentation | Fastify request logs only. | Add request/run correlation IDs, structured domain events, latency/error metrics, dashboards, and alerts. Redact candidate PII from logs. |
| Security/privacy | Local prototype protections only; resume routes require auth and resolve paths inside the upload directory. | Tenant isolation, access controls, secrets manager, backup/restore, retention/deletion, malware scanning, audit logs, rate limits, threat review, and jurisdiction-specific privacy review. |

## 7. A practical learning path for a beginner

You do not need to master everything before an interview. Be able to explain the project and learn one layer at a time:

1. **Run and trace it:** follow `README.md`; create a test recruiter account; add a fictional role and candidate; run a shortlist. Use browser devtools Network to see endpoint, status, request, and response.
2. **Learn the browser flow:** study `page.tsx` from `api()` through `submitAuth`, `createJob`, `createCandidate`, and `runShortlist`. Learn React state, form submission, `fetch`, and `async/await`.
3. **Learn the API flow:** find each matching `app.get/post/patch` handler in `index.ts`. Learn HTTP methods/status codes, JSON, request validation, and the difference between authentication and authorization.
4. **Learn the data model:** sketch the `users`, `jobs`, `candidates`, `shortlist_results`, and `meetings` tables. Understand primary keys, foreign keys, unique constraints, and why every query must be scoped to the authenticated user.
5. **Learn auth/security basics:** explain bcrypt password hashing, JWT claims, HTTP-only cookies, CORS, secrets in `.env`, and why production settings differ from localhost.
6. **Learn AI application basics:** distinguish a model call from a product feature. Learn prompt/data boundaries, structured outputs, evaluation sets, hallucinations, privacy, latency, cost, and fallback behavior.
7. **Learn integration reliability:** study OAuth, APIs, webhooks, polling, pagination, rate limits, retry/backoff, idempotency, cursors, reconciliation, and audit logs. These are a major gap between this local MVP and the job description.
8. **Make one small improvement:** for example, add runtime input schemas or a shortlist explanation test using fictional data. Be ready to describe the problem, change, verification, and remaining limitation.

Suggested mental model for a request: **UI event → HTTP request → authentication → validation/authorization → business rule → database or external API → response → UI state.** When debugging, inspect each boundary instead of guessing.

## 8. What a startup recruiter/founder will look for

This role is broader than “knows prompts.” Show evidence in these areas:

1. **Ownership and shipping:** Can you take a fuzzy workflow from customer conversation through design, implementation, deployment, and follow-up?
2. **Recruiter empathy:** Can you listen to how recruiters actually source, screen, submit, and coordinate—and avoid imposing a workflow that looks elegant only to engineers?
3. **Integration engineering:** Can you deal with inconsistent APIs, customer-specific configuration, OAuth, webhooks, rate limits, duplicate records, partial syncs, and recovery?
4. **AI judgment:** Can you choose when an LLM helps, keep deterministic rules where they are better, constrain the model, cite evidence, evaluate quality, and provide a human override?
5. **Trust and safety:** Can you protect resumes and personal data, avoid logging sensitive content, represent uncertainty, and prevent an unverified credential from appearing verified?
6. **Reliability and debugging:** Can you use logs, metrics, traces, retries, idempotency, and run history to explain what happened and recover safely?
7. **Product/business sense:** Can you connect improvements to recruiter time saved, shortlist review time, candidate response time, submission quality, customer adoption, and revenue per recruiter?
8. **Communication under ambiguity:** Can you present trade-offs clearly, write a short technical plan, demo progress, and change direction when customer evidence disagrees with your assumptions?

Bring one concrete story for each competency, ideally in **Situation → Action → Result → Learning** form. Use numbers only if you measured them; do not invent impact. If you lack work examples, use this project and be explicit that it is a local prototype.

### Product metrics worth discussing

- Time from opening a role to a recruiter-reviewed shortlist.
- Share of shortlist evidence that reviewers accept as relevant (with a sampled quality review, not just clicks).
- Missing-information follow-up rate and time to resolve it.
- Resume parse success rate by file type and source ATS.
- ATS sync freshness, failure rate, duplicate rate, and recovery time.
- AI draft edit/rejection rate, factual error rate, latency, and cost per useful draft.
- Candidate response and screen scheduling completion rates.
- Recruiter weekly active use and roles/candidates handled per recruiter.

Metrics must be segmented and interpreted carefully. Optimizing speed alone can reduce quality or fairness; a score is not success unless recruiters trust and verify the underlying evidence.

## 9. A strong, honest way to present this project

> “I built MedRecruit as a local-first physician ATS MVP using Next.js/React, a TypeScript Fastify API, and sql.js/SQLite. It covers recruiter signup and onboarding, role and candidate records, resume intake, pipeline stages, explainable rule-based shortlists, optional AI-written summaries and screening questions, and an optional Calendar/Meet flow. I kept ranking deterministic and showed evidence and gaps so the recruiter remains responsible for decisions. The project is a prototype: it does not yet integrate with an external ATS or verify licenses. If I were extending it for customers, I would first validate one recruiter workflow, add tenant-aware persistent storage and auditability, then build one read-only ATS connector with idempotent sync, rate-limit handling, and observability before adding controlled write-back.”

If asked about trade-offs: “I chose sql.js to make local setup easy and avoided requiring a database server. That made the demo simple, but whole-file persistence and local files are not a multi-tenant production design. I would keep the domain/API contract but replace persistence with a managed relational database, migrations, backups, and tenant checks before a real-data pilot.”

If asked about AI: “The model is used for drafts, not for eligibility or rejection. The shortlist is deterministic and exposes inputs. I would evaluate AI outputs against recruiter-reviewed examples, preserve source evidence, measure factual errors, and keep explicit human approval before sending or changing candidate status.”

## 10. Likely interview questions to practice

- **Why an explainable shortlist instead of LLM ranking?** Explain repeatability, auditability, evidence gaps, and why the initial signal should be visible and recruiter-controlled. Acknowledge the current matching heuristic is basic and not validated.
- **How would you integrate with a customer’s ATS?** Start with the customer’s workflow and API; use an adapter/provider boundary, secure OAuth, map external IDs, paginate, checkpoint sync cursors, upsert idempotently, respect rate limits, verify webhooks, retry transient errors, reconcile missed updates, and expose sync health. Begin read-only.
- **How do you stop bad AI output?** Constrain input and task, require structured output, validate it, preserve source passages, flag missing facts, evaluate on representative examples, log model/prompt versions without PII, provide a fallback, and require recruiter review.
- **How would you make it multi-tenant?** Add an organization/tenant model, derive tenant from trusted auth context, scope every query and file access, enforce constraints at the database boundary where possible, audit access, and add cross-tenant tests. Never trust a tenant ID supplied only by the browser.
- **How would you debug “signup returned 500 but login worked”?** Follow request/log/database steps; distinguish insert success from handler completion; locate the failing lookup; preserve the inserted ID before an export/reset side effect; fix and verify response plus session cookie.
- **What would you build next?** Tie the answer to user evidence and risk. A credible first production step is a narrow read-only ATS connector and a trustworthy sync health view, alongside tenant isolation and auditability—not a generic autonomous agent.
- **How do you know the product helps?** Define a baseline with recruiters, choose a workflow metric, sample quality and safety outcomes, measure time saved and adoption, and review failure cases before expanding automation.

## 11. Keep these limitations visible in your own explanation

- No external ATS integration, agent platform, assignments, webhook receiver, external polling sync, or alerting is implemented. Doctor application status polling is in-app only.
- User/workspace storage is not ready for multiple real customer organizations. Do not upload real candidate data to this local demo.
- License states are user-entered strings; they are not verified against a licensing authority.
- Current scoring uses exact specialty checks, simple location matching, and shallow resume keyword detection. It is not validated as predictive or fair.
- The LLM sees resume text when configured. Before real use, review vendor data terms, minimize data, and build a privacy/security plan.
- Google Calendar credentials are shared local environment configuration. Configured calendar events invite the applicant; otherwise, the dashboard can show a saved but unscheduled recruiter screen and does not expose a false event-specific Meet room. There is no separate email or SMS notification service.
- There is no automated test suite evident in this repo. A mature next step is API/unit tests for auth ownership boundaries, score reasons/gates, upload validation, and integration failure cases.
- The web page is a large client component and API routes live in one file. Refactor when it improves iteration, ownership, or testing—not just to add layers.

Your advantage is not claiming the prototype already solves the company’s whole platform problem. Show that you understand the workflow, can explain every important trade-off, know where the prototype stops, and can propose a safe, measurable next slice.
