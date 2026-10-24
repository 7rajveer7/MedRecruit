# MedRecruit — local ATS MVP

A deliberately small physician recruiting workspace. The focus is an evidence-first ATS: signup and recruiter onboarding, role setup, resume intake, explainable shortlists, AI-assisted drafts, and candidate screening meetings.

## Local stack

- **Frontend:** Next.js (`apps/web`)
- **Backend:** Fastify + TypeScript (`apps/api`)
- **Database:** SQLite via WebAssembly (`sql.js`), persisted locally at `data/medrecruit.sqlite`; no database server or native build tools required
- **Resume storage:** private local files in `storage/resumes`; only authenticated API routes can download them
- **AI:** optional OpenAI API key, used only for factual resume summaries and draft screening questions. Without a key, deterministic local fallback text is returned. AI does not rank candidates or verify licenses.
- **Meetings:** optional Google Calendar OAuth integration creates a calendar event with a unique Google Meet conference. Without OAuth configuration, the API returns a quick-join link but does not schedule an event.

## Get running locally

Requirements: Node.js 24+ and npm 10+.

```bash
test -f .env || cp .env.example .env
# If creating .env for the first time, set a private JWT_SECRET with at least 32 characters.
npm install
npm run dev
```

The interactive ATS runs at [http://localhost:3000](http://localhost:3000); the local API runs at [http://localhost:4000](http://localhost:4000). The Next.js dev server uses Webpack polling for compatibility with this machine’s file watcher limits. API health: `GET /health`. The API binds to `127.0.0.1` and allows browser requests from `WEB_ORIGIN`.

A local `.env` with a generated development JWT secret is already present on this machine. It is ignored by Git. Replace values there; never commit `.env`. The checked-in `.env.example` documents optional integration settings. The OpenAI and Google credentials are blank until you add your own.

## Lean product scope

1. **Signup and onboarding:** create a local recruiter account; choose an organization name and role (recruiter, sourcing lead, staffing manager, or hiring manager).
2. **Role intake:** create and list roles with specialty, location, requirements, and required license states.
3. **Candidate ATS:** create candidate records, upload PDF/DOCX/TXT resumes, extract text locally, track source, availability, license states, experience, and stage. Resume files remain private on disk.
4. **Innovative shortlist:** calculate a transparent 0–100 match score and show evidence and missing information. Specialty and required licenses are eligibility gates; every result retains a recruiter verification checklist.
5. **AI assistance:** draft a factual resume summary and role-specific screening questions. The local fallback works without an API key. AI does not independently verify credentials or make hiring decisions.
6. **Screening meeting:** create a scheduled Calendar event and unique Meet conference when Google OAuth is configured; otherwise return the Google Meet quick-join page and clearly mark it unscheduled.

## API routes

- `GET /` — local API welcome page with links to key endpoints
- `GET /health` — API health status
- `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `POST /api/onboarding`
- `GET/POST /api/jobs`; `POST /api/jobs/:id/shortlist`
- `GET/POST /api/candidates`; `PATCH /api/candidates/:id/stage`; `POST /api/candidates/:id/resume`; `GET /api/candidates/:id/resume`
- `POST /api/assist/resume-summary`, `POST /api/assist/screening-questions`
- `POST /api/candidates/:id/meetings`, `GET /api/meetings`

All ATS and meeting routes require the HTTP-only local session cookie. The MVP is single-user/local-development software and is not ready for real candidate data or production deployment. Before a pilot, add organization-level isolation, backups, audit history, rate limiting, malware scanning for uploaded files, credential verification workflows, and a specialist review of privacy and applicable legal obligations.

## Current matching logic

Specialty 35, license evidence 25, location 15, recorded availability 10, resume evidence 5, and experience up to 10. The score is a recruiter prioritization aid, not a clinical or employment decision. Missing or unverified credential evidence is displayed instead of being guessed.
