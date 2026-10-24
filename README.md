# MedRecruit — local physician recruiting platform

MedRecruit is a local-first recruiting prototype for physician roles. It includes a recruiter ATS and a doctor portal so applicants can create an account, upload a resume, apply to open roles, and track application and meeting updates.

## Local stack

- **Frontend:** Next.js + React (`apps/web`)
- **Backend:** Fastify + TypeScript (`apps/api`)
- **Database:** SQLite via WebAssembly (`sql.js`), persisted at `data/medrecruit.sqlite`
- **Resume storage:** local files in `storage/resumes`; recruiter and doctor APIs authorize access to their own records
- **AI:** optional OpenAI API key for factual resume summaries and screening question drafts. AI does not rank candidates or verify licenses.
- **Meetings:** without external credentials, MedRecruit creates a unique Jitsi room and displays the join link in the doctor dashboard. Optional Google Calendar OAuth creates a Calendar event, requests a Google Meet room, and sends the attendee invitation.

## Get running locally

Requirements: Node.js 24+ and npm 10+.

```bash
test -f .env || cp .env.example .env
# If creating .env for the first time, set a private JWT_SECRET with at least 32 characters.
npm install
npm run dev
```

- Recruiter ATS: [http://localhost:3000](http://localhost:3000)
- Doctor portal: [http://localhost:3000/doctor](http://localhost:3000/doctor)
- Local API: [http://localhost:4000](http://localhost:4000)
- Health check: `GET /health`

The web and API run as separate local processes. The API binds to `127.0.0.1` and accepts browser requests from `WEB_ORIGIN`. `.env` is ignored by Git. Never commit real credentials; `.env.example` documents the expected variables.

## Doctor application workflow

1. A recruiter signs in to the ATS and creates a role. Open roles appear on the public doctor portal.
2. A doctor visits `/doctor`, creates a doctor account, and completes their profile with specialty, degree and specialty training, location, license states, availability, experience, and a PDF/DOCX/TXT resume.
3. The doctor applies to an open role. MedRecruit creates an application and a recruiter-owned candidate record linked to that role.
4. The recruiter reviews the person under **Candidates** and changes their ATS stage. The doctor dashboard reflects statuses such as **Applied**, **Under consideration**, **Interview**, **Offer**, **Rejected**, and **Expired**.
5. A doctor’s dashboard refreshes application and meeting information every 20 seconds while open. Closing a role expires its applications. When a recruiter schedules a screen, the doctor sees the date, time, and join link in the dashboard. Google Calendar is optional: without it, MedRecruit creates a unique Jitsi room. With Calendar OAuth configured, it creates a Calendar event with a Google Meet room and invite.

## Recruiter ATS features

1. **Signup and onboarding:** create a recruiter account, workspace name, and recruiting role.
2. **Role intake:** create, close, and reopen roles with specialty, location, notes, and required license states.
3. **Candidate ATS:** manually add candidates or receive doctor portal applications; upload PDF/DOCX/TXT resumes, track source, availability, license states, experience, and pipeline stage.
4. **Education-aware evidence shortlist:** require a matching candidate specialty, a recorded medical degree, and role-related specialty training before scoring. A mismatch or missing education gives 0 points and fails eligibility; years of experience count only after that gate. Configured license-state requirements also gate eligibility. Recruiters should verify education and credentials against primary documents.
5. **AI assistance:** draft factual resume summaries and role-specific screening questions. Local fallback text works without an API key.
6. **Screen meetings:** schedule a recruiter screen and create a join link. No credentials are needed for a Jitsi room; optional Google Calendar OAuth creates a calendar invitation and Google Meet link instead.

## API routes

- `GET /`, `GET /health`
- Recruiter: `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/onboarding`
- Roles: `GET/POST /api/jobs`, `PATCH /api/jobs/:id/status`, `POST /api/jobs/:id/shortlist`
- Candidates: `GET/POST /api/candidates`, `PATCH /api/candidates/:id/stage`, `PATCH /api/candidates/:id/education`, `POST/GET /api/candidates/:id/resume`
- Doctors: `POST /api/doctor/auth/signup`, `POST /api/doctor/auth/login`, `GET /api/doctor/auth/me`, `GET/PATCH /api/doctor/profile`, `POST /api/doctor/profile/resume`, `GET /api/doctor/applications`
- Public roles/applications: `GET /api/public/jobs`, `POST /api/public/jobs/:id/applications`
- AI: `POST /api/assist/resume-summary`, `POST /api/assist/screening-questions`
- Meetings: `POST /api/candidates/:id/meetings`, `GET /api/meetings`

## Matching logic and boundaries

After the specialty and education gate passes, the match signal uses specialty (35), license-state evidence (25), location (15), recorded availability (10), resume keyword evidence (5), and experience (up to 10). Education must list an MD, DO, MBBS, MBChB, or equivalent recognized degree plus text matching the role specialty (for example, `MD; Internal Medicine residency; Cardiology fellowship` for a Cardiology role). This is a text-based evidence check, not an accreditation or credential verification. License states are entered by a user and are **not verified by a licensing board**. Scores are recruiter prioritization aids, not hiring decisions or clinical assessments.

This is a local prototype, not ready for real candidate data or production deployment. It has no external ATS connector, email service, automated test suite, organization-level isolation, backup/recovery process, audit history, rate limiting, or malware scanning. Before a customer pilot, add tenant-scoped authorization, database migrations and managed persistence, secure resume storage and retention, auditability, integration reliability, credential verification workflows, and specialist privacy/legal review.
