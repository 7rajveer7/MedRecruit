import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import bcrypt from "bcryptjs";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { config } from "dotenv";

// npm workspace scripts run this app from apps/api; keep local data at the monorepo root.
const repoRoot = resolve(process.cwd(), "../..");
config({ path: join(repoRoot, ".env") });
const dataDir = resolve(repoRoot, process.env.DATA_DIR ?? "data");
const uploadDir = resolve(repoRoot, process.env.UPLOAD_DIR ?? "storage/resumes");
const databasePath = resolve(repoRoot, process.env.DATABASE_PATH ?? "data/medrecruit.sqlite");
mkdirSync(dataDir, { recursive: true });
mkdirSync(uploadDir, { recursive: true });

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
const allowedWebOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
await app.register(cors, { origin: allowedWebOrigin, credentials: true });
await app.register(cookie);
await app.register(jwt, {
  secret: process.env.JWT_SECRET ?? "",
  cookie: { cookieName: "medrecruit_session", signed: false },
  sign: { expiresIn: "7d" }
});
await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024, files: 1 } });

const SQL = await initSqlJs({ locateFile: (file) => join(repoRoot, "node_modules/sql.js/dist", file) });
let db: Database = existsSync(databasePath)
  ? new SQL.Database(readFileSync(databasePath))
  : new SQL.Database();
db.run("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    company_name TEXT,
    recruiter_role TEXT,
    onboarding_completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS doctor_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    specialty TEXT NOT NULL DEFAULT '',
    education TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    license_states TEXT NOT NULL DEFAULT '[]',
    availability TEXT NOT NULL DEFAULT '',
    experience_years INTEGER NOT NULL DEFAULT 0,
    resume_filename TEXT,
    resume_storage_key TEXT,
    resume_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    specialty TEXT NOT NULL,
    location TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    required_licenses TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'Open',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    specialty TEXT NOT NULL DEFAULT '',
    education TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    license_states TEXT NOT NULL DEFAULT '[]',
    availability TEXT NOT NULL DEFAULT '',
    experience_years INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'Manual entry',
    resume_filename TEXT,
    resume_storage_key TEXT,
    resume_text TEXT NOT NULL DEFAULT '',
    doctor_id INTEGER,
    stage TEXT NOT NULL DEFAULT 'New',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shortlist_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    fit_score INTEGER NOT NULL,
    eligible INTEGER NOT NULL,
    reasons TEXT NOT NULL,
    gaps TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    UNIQUE(job_id, candidate_id)
  );
  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    meet_url TEXT NOT NULL,
    calendar_event_id TEXT,
    calendar_event_url TEXT,
    provider TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doctor_id INTEGER NOT NULL REFERENCES doctor_accounts(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    candidate_id INTEGER NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'Applied',
    applied_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(doctor_id, job_id)
  );
`);

// Older local databases predate the doctor portal. Keep them usable without deleting recruiter data.
const candidateColumns = rows<{ name: string }>("PRAGMA table_info(candidates)").map((column) => column.name);
if (!candidateColumns.includes("doctor_id")) db.run("ALTER TABLE candidates ADD COLUMN doctor_id INTEGER");
if (!candidateColumns.includes("education")) db.run("ALTER TABLE candidates ADD COLUMN education TEXT NOT NULL DEFAULT ''");
const doctorColumns = rows<{ name: string }>("PRAGMA table_info(doctor_accounts)").map((column) => column.name);
if (!doctorColumns.includes("education")) db.run("ALTER TABLE doctor_accounts ADD COLUMN education TEXT NOT NULL DEFAULT ''");
const meetingColumns = rows<{ name: string }>("PRAGMA table_info(meetings)").map((column) => column.name);
if (!meetingColumns.includes("provider")) db.run("ALTER TABLE meetings ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown'");

function persist() {
  writeFileSync(databasePath, Buffer.from(db.export()));
}
persist();

function rows<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const result: T[] = [];
    while (statement.step()) result.push(statement.getAsObject() as T);
    return result;
  } finally {
    statement.free();
  }
}
function one<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | undefined {
  return rows<T>(sql, params)[0];
}
function run(sql: string, params: SqlValue[] = []) {
  db.run(sql, params);
}
function newId() {
  return Number(one<{ id: number }>("SELECT last_insert_rowid() AS id")?.id ?? 0);
}
function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  return [];
}
function cleanUser(user: Record<string, unknown>) {
  const { password_hash: _password, ...safe } = user;
  return { ...safe, onboardingCompleted: Boolean(safe.onboarding_completed) };
}
function authPayload(request: FastifyRequest) {
  return request.user as { sub?: number; accountType?: string };
}
function userId(request: FastifyRequest) {
  const payload = authPayload(request);
  return Number(payload.sub);
}
function doctorId(request: FastifyRequest) {
  return Number(authPayload(request).sub);
}
async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    if (authPayload(request).accountType === "doctor") return reply.code(403).send({ error: "Recruiter access is required." });
  } catch {
    return reply.code(401).send({ error: "Sign in to continue." });
  }
}
async function requireDoctor(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    if (authPayload(request).accountType !== "doctor") return reply.code(403).send({ error: "Doctor access is required." });
  } catch {
    return reply.code(401).send({ error: "Sign in as a doctor to continue." });
  }
}
function cookieOptions() {
  return { path: "/", httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 };
}
function session(reply: FastifyReply, user: Record<string, unknown>) {
  const token = app.jwt.sign({ sub: Number(user.id) });
  reply.setCookie("medrecruit_session", token, cookieOptions());
}
function doctorSession(reply: FastifyReply, doctor: Record<string, unknown>) {
  const token = app.jwt.sign({ sub: Number(doctor.id), accountType: "doctor" });
  reply.setCookie("medrecruit_session", token, cookieOptions());
}
function cleanDoctor(doctor: Record<string, unknown>) {
  const { password_hash: _password, resume_text: _resumeText, resume_storage_key: _storage, ...safe } = doctor;
  return { ...safe, licenseStates: JSON.parse(String(safe.license_states ?? "[]")), hasResume: Boolean(safe.resume_filename) };
}
function normalize(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
function safeCandidate(candidate: Record<string, unknown>) {
  const { resume_text: resumeText, resume_storage_key: _storage, ...safe } = candidate;
  return { ...safe, licenseStates: JSON.parse(String(safe.license_states ?? "[]")), resumeAvailable: Boolean(safe.resume_filename), hasResumeText: Boolean(resumeText) };
}
function candidateFor(user: number, id: number) {
  return one<Record<string, unknown>>("SELECT * FROM candidates WHERE id = ? AND user_id = ?", [id, user]);
}
function jobFor(user: number, id: number) {
  return one<Record<string, unknown>>("SELECT * FROM jobs WHERE id = ? AND user_id = ?", [id, user]);
}

app.get("/", async () => ({
  name: "MedRecruit local API",
  status: "ok",
  message: "The backend is running. Use the web app at http://localhost:3000 for the recruiter workflow.",
  endpoints: {
    health: "GET /health",
    signup: "POST /api/auth/signup",
    login: "POST /api/auth/login",
    jobs: "GET /api/jobs",
    candidates: "GET /api/candidates"
  }
}));
app.get("/health", async () => ({ status: "ok", service: "medrecruit-local-api", storage: "sqlite-wasm" }));

function publicJob(job: Record<string, unknown>) {
  return { id: Number(job.id), title: String(job.title), specialty: String(job.specialty), location: String(job.location), description: String(job.description ?? ""), requiredLicenses: JSON.parse(String(job.required_licenses ?? "[]")) as string[], companyName: String(job.company_name || "Healthcare team"), status: String(job.status) };
}

app.get("/api/public/jobs", async () => {
  const openJobs = rows<Record<string, unknown>>("SELECT jobs.*, users.company_name FROM jobs JOIN users ON users.id = jobs.user_id WHERE jobs.status = 'Open' ORDER BY jobs.created_at DESC");
  return openJobs.map(publicJob);
});

app.post<{ Body: { name?: string; email?: string; password?: string } }>("/api/doctor/auth/signup", async (request, reply) => {
  const name = normalize(request.body?.name);
  const email = normalize(request.body?.email).toLowerCase();
  const password = request.body?.password ?? "";
  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10) return reply.code(400).send({ error: "Provide a name, valid email, and password with at least 10 characters." });
  if (one("SELECT id FROM users WHERE email = ? UNION SELECT id FROM doctor_accounts WHERE email = ?", [email, email])) return reply.code(409).send({ error: "An account already exists for this email." });
  const now = new Date().toISOString();
  run("INSERT INTO doctor_accounts (name, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [name, email, await bcrypt.hash(password, 12), now, now]);
  const id = newId();
  persist();
  const doctor = one<Record<string, unknown>>("SELECT * FROM doctor_accounts WHERE id = ?", [id])!;
  doctorSession(reply, doctor);
  return reply.code(201).send({ doctor: cleanDoctor(doctor) });
});

app.post<{ Body: { email?: string; password?: string } }>("/api/doctor/auth/login", async (request, reply) => {
  const email = normalize(request.body?.email).toLowerCase();
  const doctor = one<Record<string, unknown>>("SELECT * FROM doctor_accounts WHERE email = ?", [email]);
  if (!doctor || !(await bcrypt.compare(request.body?.password ?? "", String(doctor.password_hash)))) return reply.code(401).send({ error: "Email or password is incorrect." });
  doctorSession(reply, doctor);
  return { doctor: cleanDoctor(doctor) };
});

app.get("/api/doctor/auth/me", { preHandler: requireDoctor }, async (request, reply) => {
  const doctor = one<Record<string, unknown>>("SELECT * FROM doctor_accounts WHERE id = ?", [doctorId(request)]);
  if (!doctor) return reply.code(404).send({ error: "Doctor account not found." });
  return { doctor: cleanDoctor(doctor) };
});

app.get("/api/doctor/profile", { preHandler: requireDoctor }, async (request, reply) => {
  const doctor = one<Record<string, unknown>>("SELECT * FROM doctor_accounts WHERE id = ?", [doctorId(request)]);
  if (!doctor) return reply.code(404).send({ error: "Doctor account not found." });
  return { doctor: cleanDoctor(doctor) };
});

app.patch<{ Body: { specialty?: string; education?: string; location?: string; licenseStates?: unknown; availability?: string; experienceYears?: number } }>("/api/doctor/profile", { preHandler: requireDoctor }, async (request, reply) => {
  const experience = Math.max(0, Math.min(60, Number(request.body?.experienceYears) || 0));
  run("UPDATE doctor_accounts SET specialty = ?, education = ?, location = ?, license_states = ?, availability = ?, experience_years = ?, updated_at = ? WHERE id = ?", [normalize(request.body?.specialty), normalize(request.body?.education), normalize(request.body?.location), JSON.stringify(jsonArray(request.body?.licenseStates)), normalize(request.body?.availability), experience, new Date().toISOString(), doctorId(request)]);
  run("UPDATE candidates SET specialty = ?, education = ? WHERE doctor_id = ?", [normalize(request.body?.specialty), normalize(request.body?.education), doctorId(request)]);
  persist();
  const doctor = one<Record<string, unknown>>("SELECT * FROM doctor_accounts WHERE id = ?", [doctorId(request)]);
  if (!doctor) return reply.code(404).send({ error: "Doctor account not found." });
  return { doctor: cleanDoctor(doctor) };
});

app.post("/api/doctor/profile/resume", { preHandler: requireDoctor }, async (request, reply) => {
  const upload = await request.file();
  if (!upload) return reply.code(400).send({ error: "Attach a PDF, DOCX, or TXT resume." });
  const extension = extname(upload.filename).toLowerCase();
  if (![".pdf", ".docx", ".txt"].includes(extension)) return reply.code(400).send({ error: "Only PDF, DOCX, and TXT resumes are supported." });
  const buffer = await upload.toBuffer();
  let text = "";
  try {
    if (extension === ".pdf") text = (await pdfParse(buffer)).text;
    else if (extension === ".docx") text = (await mammoth.extractRawText({ buffer })).value;
    else text = buffer.toString("utf8");
  } catch {
    return reply.code(422).send({ error: "Could not read this resume file. Try a text-based PDF, DOCX, or TXT." });
  }
  const storageKey = `${randomUUID()}${extension}`;
  writeFileSync(join(uploadDir, storageKey), buffer, { flag: "wx" });
  run("UPDATE doctor_accounts SET resume_filename = ?, resume_storage_key = ?, resume_text = ?, updated_at = ? WHERE id = ?", [upload.filename.replace(/[\\/]/g, "_").slice(0, 180), storageKey, text.slice(0, 150_000), new Date().toISOString(), doctorId(request)]);
  persist();
  const doctor = one<Record<string, unknown>>("SELECT * FROM doctor_accounts WHERE id = ?", [doctorId(request)]);
  if (!doctor) return reply.code(404).send({ error: "Doctor account not found." });
  return { doctor: cleanDoctor(doctor) };
});

app.post<{ Params: { id: string } }>("/api/public/jobs/:id/applications", { preHandler: requireDoctor }, async (request, reply) => {
  const doctor = one<Record<string, unknown>>("SELECT * FROM doctor_accounts WHERE id = ?", [doctorId(request)]);
  if (!doctor) return reply.code(404).send({ error: "Doctor account not found." });
  if (!doctor.resume_storage_key || !normalize(doctor.specialty) || !normalize(doctor.education)) return reply.code(400).send({ error: "Complete your specialty and education details and upload a resume before applying." });
  const job = one<Record<string, unknown>>("SELECT * FROM jobs WHERE id = ? AND status = 'Open'", [Number(request.params.id)]);
  if (!job) return reply.code(404).send({ error: "This role is no longer open." });
  if (one("SELECT id FROM applications WHERE doctor_id = ? AND job_id = ?", [doctorId(request), Number(job.id)])) return reply.code(409).send({ error: "You have already applied to this role." });
  const now = new Date().toISOString();
  run("INSERT INTO candidates (user_id, name, email, specialty, education, location, license_states, availability, experience_years, source, resume_filename, resume_storage_key, resume_text, doctor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [Number(job.user_id), String(doctor.name), String(doctor.email), String(doctor.specialty), String(doctor.education ?? ""), String(doctor.location), String(doctor.license_states), String(doctor.availability), Number(doctor.experience_years), "Doctor portal application", String(doctor.resume_filename), String(doctor.resume_storage_key), String(doctor.resume_text ?? ""), doctorId(request), now]);
  const candidateId = newId();
  run("INSERT INTO applications (doctor_id, job_id, candidate_id, status, applied_at, updated_at) VALUES (?, ?, ?, 'Applied', ?, ?)", [doctorId(request), Number(job.id), candidateId, now, now]);
  const applicationId = newId();
  persist();
  return reply.code(201).send({ application: { id: applicationId, job: publicJob({ ...job, company_name: one<{ company_name: string }>("SELECT company_name FROM users WHERE id = ?", [Number(job.user_id)])?.company_name }), status: "Applied", appliedAt: now } });
});

app.get("/api/doctor/applications", { preHandler: requireDoctor }, async (request) => {
  const applications = rows<Record<string, unknown>>("SELECT applications.id, applications.status, applications.applied_at, applications.updated_at, applications.candidate_id, jobs.id AS job_id, jobs.title, jobs.specialty, jobs.location, jobs.status AS job_status, users.company_name FROM applications JOIN jobs ON jobs.id = applications.job_id JOIN users ON users.id = jobs.user_id WHERE applications.doctor_id = ? ORDER BY applications.applied_at DESC", [doctorId(request)]);
  return applications.map((application) => ({
    id: Number(application.id),
    status: application.job_status === "Closed" ? "Expired" : String(application.status),
    appliedAt: String(application.applied_at),
    updatedAt: String(application.updated_at),
    job: { id: Number(application.job_id), title: String(application.title), specialty: String(application.specialty), location: String(application.location), companyName: String(application.company_name || "Healthcare team"), status: String(application.job_status) },
    meetings: rows<Record<string, unknown>>("SELECT id, title, starts_at, meet_url, calendar_event_url, calendar_event_id, provider FROM meetings WHERE candidate_id = ? ORDER BY starts_at DESC", [Number(application.candidate_id)]).map((meeting) => ({ id: Number(meeting.id), title: String(meeting.title), startsAt: String(meeting.starts_at), meetUrl: String(meeting.meet_url), calendarEventUrl: meeting.calendar_event_url ? String(meeting.calendar_event_url) : null, provider: String(meeting.provider), scheduled: !String(meeting.meet_url).endsWith("/new"), meetReady: !String(meeting.meet_url).endsWith("/new") }))
  }));
});

app.post<{ Body: { name?: string; email?: string; password?: string } }>("/api/auth/signup", async (request, reply) => {
  const name = normalize(request.body?.name);
  const email = normalize(request.body?.email).toLowerCase();
  const password = request.body?.password ?? "";
  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10) {
    return reply.code(400).send({ error: "Provide a name, valid email, and password with at least 10 characters." });
  }
  if (one("SELECT id FROM users WHERE email = ? UNION SELECT id FROM doctor_accounts WHERE email = ?", [email, email])) return reply.code(409).send({ error: "An account already exists for this email." });
  run("INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)", [name, email, await bcrypt.hash(password, 12), new Date().toISOString()]);
  const id = newId();
  persist();
  const user = one<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [id])!;
  session(reply, user);
  return reply.code(201).send({ user: cleanUser(user) });
});

app.post<{ Body: { email?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
  const email = normalize(request.body?.email).toLowerCase();
  const user = one<Record<string, unknown>>("SELECT * FROM users WHERE email = ?", [email]);
  const password = request.body?.password ?? "";
  if (!user || !(await bcrypt.compare(password, String(user.password_hash)))) return reply.code(401).send({ error: "Email or password is incorrect." });
  session(reply, user);
  return { user: cleanUser(user) };
});

app.post("/api/auth/logout", async (_request, reply) => {
  reply.clearCookie("medrecruit_session", { path: "/" });
  return { ok: true };
});

app.get("/api/auth/me", { preHandler: requireAuth }, async (request) => {
  const user = one<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [userId(request)]);
  return { user: user ? cleanUser(user) : null };
});

app.post<{ Body: { companyName?: string; recruiterRole?: string } }>("/api/onboarding", { preHandler: requireAuth }, async (request, reply) => {
  const company = normalize(request.body?.companyName);
  const role = normalize(request.body?.recruiterRole);
  const roles = ["recruiter", "sourcing_lead", "staffing_manager", "hiring_manager"];
  if (company.length < 2 || !roles.includes(role)) return reply.code(400).send({ error: "Choose a company name and a supported onboarding role." });
  run("UPDATE users SET company_name = ?, recruiter_role = ?, onboarding_completed = 1 WHERE id = ?", [company, role, userId(request)]);
  persist();
  const user = one<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [userId(request)])!;
  return { user: cleanUser(user) };
});

app.get("/api/jobs", { preHandler: requireAuth }, async (request) => {
  const jobs = rows<Record<string, unknown>>("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC", [userId(request)]);
  return jobs.map((job) => ({ ...job, requiredLicenses: JSON.parse(String(job.required_licenses)) }));
});

app.post<{ Body: { title?: string; specialty?: string; location?: string; description?: string; requiredLicenses?: unknown } }>("/api/jobs", { preHandler: requireAuth }, async (request, reply) => {
  const title = normalize(request.body?.title);
  const specialty = normalize(request.body?.specialty);
  const location = normalize(request.body?.location);
  if (!title || !specialty || !location) return reply.code(400).send({ error: "Role title, specialty, and location are required." });
  run("INSERT INTO jobs (user_id, title, specialty, location, description, required_licenses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [userId(request), title, specialty, location, normalize(request.body?.description), JSON.stringify(jsonArray(request.body?.requiredLicenses)), new Date().toISOString()]);
  const id = newId();
  persist();
  const job = one<Record<string, unknown>>("SELECT * FROM jobs WHERE id = ?", [id])!;
  return reply.code(201).send({ ...job, requiredLicenses: JSON.parse(String(job.required_licenses)) });
});

app.patch<{ Params: { id: string }; Body: { status?: string } }>("/api/jobs/:id/status", { preHandler: requireAuth }, async (request, reply) => {
  const status = normalize(request.body?.status);
  if (!["Open", "Closed"].includes(status)) return reply.code(400).send({ error: "Choose Open or Closed." });
  const job = jobFor(userId(request), Number(request.params.id));
  if (!job) return reply.code(404).send({ error: "Role not found." });
  run("UPDATE jobs SET status = ? WHERE id = ? AND user_id = ?", [status, Number(job.id), userId(request)]);
  if (status === "Closed") {
    const now = new Date().toISOString();
    run("UPDATE applications SET status = 'Expired', updated_at = ? WHERE job_id = ?", [now, Number(job.id)]);
    run("UPDATE candidates SET stage = 'Expired' WHERE id IN (SELECT candidate_id FROM applications WHERE job_id = ?)", [Number(job.id)]);
  }
  persist();
  return { job: { ...job, status } };
});

app.get("/api/candidates", { preHandler: requireAuth }, async (request) => {
  const candidates = rows<Record<string, unknown>>("SELECT candidates.*, jobs.title AS application_job_title FROM candidates LEFT JOIN applications ON applications.candidate_id = candidates.id LEFT JOIN jobs ON jobs.id = applications.job_id WHERE candidates.user_id = ? ORDER BY candidates.created_at DESC", [userId(request)]);
  return candidates.map(safeCandidate);
});

app.post<{ Body: { name?: string; email?: string; specialty?: string; education?: string; location?: string; licenseStates?: unknown; availability?: string; experienceYears?: number; source?: string } }>("/api/candidates", { preHandler: requireAuth }, async (request, reply) => {
  const name = normalize(request.body?.name);
  if (name.length < 2) return reply.code(400).send({ error: "Candidate name is required." });
  const experience = Math.max(0, Math.min(60, Number(request.body?.experienceYears) || 0));
  run("INSERT INTO candidates (user_id, name, email, specialty, education, location, license_states, availability, experience_years, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [userId(request), name, normalize(request.body?.email).toLowerCase(), normalize(request.body?.specialty), normalize(request.body?.education), normalize(request.body?.location), JSON.stringify(jsonArray(request.body?.licenseStates)), normalize(request.body?.availability), experience, normalize(request.body?.source) || "Manual entry", new Date().toISOString()]);
  const id = newId();
  persist();
  return reply.code(201).send(safeCandidate(one<Record<string, unknown>>("SELECT * FROM candidates WHERE id = ?", [id])!));
});

app.patch<{ Params: { id: string }; Body: { stage?: string } }>("/api/candidates/:id/stage", { preHandler: requireAuth }, async (request, reply) => {
  const stages = ["New", "Contacted", "Interested", "Screening", "Submitted", "Interview", "Offer", "Placed", "Rejected", "Expired", "Archived"];
  const stage = normalize(request.body?.stage);
  if (!stages.includes(stage)) return reply.code(400).send({ error: "Choose a supported ATS stage." });
  const candidate = candidateFor(userId(request), Number(request.params.id));
  if (!candidate) return reply.code(404).send({ error: "Candidate not found." });
  run("UPDATE candidates SET stage = ? WHERE id = ? AND user_id = ?", [stage, Number(candidate.id), userId(request)]);
  const applicationStatus = stage === "New" ? "Applied"
    : stage === "Interview" || stage === "Screening" ? "Interview"
    : stage === "Offer" || stage === "Placed" ? "Offer"
    : stage === "Rejected" ? "Rejected"
    : stage === "Expired" || stage === "Archived" ? "Expired"
    : "Under consideration";
  run("UPDATE applications SET status = ?, updated_at = ? WHERE candidate_id = ?", [applicationStatus, new Date().toISOString(), Number(candidate.id)]);
  persist();
  return { candidate: safeCandidate(candidateFor(userId(request), Number(candidate.id))!) };
});

app.patch<{ Params: { id: string }; Body: { education?: string } }>("/api/candidates/:id/education", { preHandler: requireAuth }, async (request, reply) => {
  const candidate = candidateFor(userId(request), Number(request.params.id));
  if (!candidate) return reply.code(404).send({ error: "Candidate not found." });
  const education = normalize(request.body?.education);
  if (!education) return reply.code(400).send({ error: "Enter the candidate’s medical degree and specialty training." });
  run("UPDATE candidates SET education = ? WHERE id = ? AND user_id = ?", [education, Number(candidate.id), userId(request)]);
  persist();
  return { candidate: safeCandidate(candidateFor(userId(request), Number(candidate.id))!) };
});

app.post<{ Params: { id: string } }>("/api/candidates/:id/resume", { preHandler: requireAuth }, async (request, reply) => {
  const id = Number(request.params.id);
  const candidate = candidateFor(userId(request), id);
  if (!candidate) return reply.code(404).send({ error: "Candidate not found." });
  const upload = await request.file();
  if (!upload) return reply.code(400).send({ error: "Attach a PDF, DOCX, or TXT resume." });
  const extension = extname(upload.filename).toLowerCase();
  if (![".pdf", ".docx", ".txt"].includes(extension)) return reply.code(400).send({ error: "Only PDF, DOCX, and TXT resumes are supported." });
  const buffer = await upload.toBuffer();
  let text = "";
  try {
    if (extension === ".pdf") text = (await pdfParse(buffer)).text;
    else if (extension === ".docx") text = (await mammoth.extractRawText({ buffer })).value;
    else text = buffer.toString("utf8");
  } catch {
    return reply.code(422).send({ error: "Could not read this resume file. Try a text-based PDF, DOCX, or TXT." });
  }
  const storageKey = `${randomUUID()}${extension}`;
  writeFileSync(join(uploadDir, storageKey), buffer, { flag: "wx" });
  run("UPDATE candidates SET resume_filename = ?, resume_storage_key = ?, resume_text = ? WHERE id = ? AND user_id = ?", [upload.filename.replace(/[\\/]/g, "_").slice(0, 180), storageKey, text.slice(0, 150_000), id, userId(request)]);
  persist();
  return { candidate: safeCandidate(candidateFor(userId(request), id)!), extractedCharacters: text.length };
});

app.get<{ Params: { id: string } }>("/api/candidates/:id/resume", { preHandler: requireAuth }, async (request, reply) => {
  const candidate = candidateFor(userId(request), Number(request.params.id));
  if (!candidate?.resume_storage_key) return reply.code(404).send({ error: "Resume not found." });
  const key = String(candidate.resume_storage_key);
  const path = resolve(uploadDir, key);
  if (!path.startsWith(`${resolve(uploadDir)}/`)) return reply.code(400).send({ error: "Invalid resume path." });
  const ext = extname(key);
  const contentType = ext === ".pdf" ? "application/pdf" : ext === ".docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain; charset=utf-8";
  return reply.type(contentType).header("Content-Disposition", `attachment; filename="${String(candidate.resume_filename).replace(/"/g, "")}"`).send(readFileSync(path));
});

app.post<{ Params: { id: string } }>("/api/jobs/:id/shortlist", { preHandler: requireAuth }, async (request, reply) => {
  const user = userId(request);
  const job = jobFor(user, Number(request.params.id));
  if (!job) return reply.code(404).send({ error: "Job not found." });
  const required = JSON.parse(String(job.required_licenses)) as string[];
  const candidates = rows<Record<string, unknown>>("SELECT * FROM candidates WHERE user_id = ? AND (doctor_id IS NULL OR id IN (SELECT candidate_id FROM applications WHERE job_id = ?))", [user, Number(job.id)]);
  const results = candidates.map((candidate) => {
    const licenses = JSON.parse(String(candidate.license_states)) as string[];
    const reasons: string[] = [];
    const gaps: string[] = [];
    const specialtyFit = String(candidate.specialty).toLowerCase() === String(job.specialty).toLowerCase();
    const education = String(candidate.education ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const specialtyTerms = String(job.specialty).toLowerCase().replace(/\b(medicine|medical|physician|doctor|and)\b/g, " ").split(/[^a-z0-9]+/).filter((term) => term.length > 2);
    const hasMedicalDegree = /\b(md|do|mbbs|mbchb)\b/.test(education) || ["doctor of medicine", "doctor of osteopathic medicine", "medical degree"].some((term) => education.includes(term));
    const educationSpecialtyFit = specialtyTerms.length === 0 || specialtyTerms.some((term) => education.includes(term));
    const educationFit = hasMedicalDegree && educationSpecialtyFit;
    const roleFieldFit = specialtyFit && educationFit;
    const licenseMatches = required.filter((license) => licenses.some((candidateLicense) => candidateLicense.toLowerCase() === license.toLowerCase()));
    const locationFit = String(candidate.location).toLowerCase().includes(String(job.location).split(",")[0].toLowerCase());
    const resume = String(candidate.resume_text).toLowerCase();
    const keywordFit = resume.length > 0 && [String(job.specialty).toLowerCase(), ...required.map((item) => item.toLowerCase())].some((term) => term.length > 2 && resume.includes(term));
    let score = 0;
    if (specialtyFit) { score += 35; reasons.push(`Specialty matches ${job.specialty} (+35).`); } else gaps.push(`Specialty differs from ${job.specialty}.`);
    if (educationFit) reasons.push(`Medical degree and education evidence match ${job.specialty}.`);
    else if (!hasMedicalDegree) gaps.push("Relevant medical education is missing or unverified; record an MD, DO, MBBS, or equivalent degree.");
    else gaps.push(`Education does not show training in ${job.specialty}; verify degree and specialty training.`);
    if (required.length === 0) { score += 25; reasons.push("No role-specific license requirement was configured (+25 neutral). "); }
    else if (licenseMatches.length === required.length) { score += 25; reasons.push(`Required license evidence matches (${licenseMatches.length}/${required.length}; +25).`); }
    else if (licenseMatches.length > 0) { score += Math.round(25 * licenseMatches.length / required.length); gaps.push(`License evidence covers ${licenseMatches.length}/${required.length} required items; verify the rest.`); }
    else gaps.push("Required license evidence is missing; recruiter verification needed.");
    if (locationFit) { score += 15; reasons.push(`Location is compatible with ${job.location} (+15).`); } else gaps.push(`Confirm location or willingness to travel to ${job.location}.`);
    const hasAvailability = String(candidate.availability).trim().length > 0;
    if (hasAvailability) { score += 10; reasons.push("Availability is recorded (+10). "); } else gaps.push("Availability has not been recorded.");
    if (keywordFit) { score += 5; reasons.push("Resume contains role-related evidence (+5); review the source text."); } else gaps.push("No related terms found in the uploaded resume text.");
    if (roleFieldFit && Number(candidate.experience_years) > 0) { score += Math.min(10, Number(candidate.experience_years)); reasons.push(`Experience recorded: ${candidate.experience_years} years (up to +10), counted because specialty and relevant education match.`); }
    else if (!roleFieldFit) gaps.push("Experience earns no shortlist points until the candidate specialty and relevant medical education match the role.");
    else gaps.push("Relevant experience years have not been recorded.");
    if (!roleFieldFit) {
      score = 0;
      reasons.length = 0;
      reasons.push("0 shortlist points: candidate specialty and relevant medical degree/field education must match the role before scoring.");
    }
    score = Math.min(100, score);
    const eligible = roleFieldFit && (required.length === 0 || licenseMatches.length === required.length);
    run("INSERT INTO shortlist_results (user_id, job_id, candidate_id, fit_score, eligible, reasons, gaps, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, candidate_id) DO UPDATE SET fit_score=excluded.fit_score, eligible=excluded.eligible, reasons=excluded.reasons, gaps=excluded.gaps, generated_at=excluded.generated_at", [user, Number(job.id), Number(candidate.id), score, eligible ? 1 : 0, JSON.stringify(reasons), JSON.stringify(gaps), new Date().toISOString()]);
    return { candidate: safeCandidate(candidate), fitScore: score, eligible, reasons, gaps };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.fitScore - a.fitScore);
  persist();
  return { job: { id: job.id, title: job.title }, scoring: "Specialty 35 · licenses 25 · location 15 · availability 10 · resume evidence 5 · relevant experience up to 10. Eligibility requires matching specialty, relevant medical degree/field education, and any required licenses. Experience points are withheld if education is missing or unrelated.", results };
});

async function aiDraft(prompt: string, fallback: string) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { text: fallback, mode: "local-fallback" };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini", messages: [{ role: "system", content: "You assist a physician recruiter. Use only supplied information. Do not infer or verify credentials, make a hiring recommendation, or invent facts. Clearly flag missing evidence." }, { role: "user", content: prompt }], temperature: 0.2 })
  });
  if (!response.ok) throw new Error(`AI provider returned ${response.status}.`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return { text: payload.choices?.[0]?.message?.content?.trim() ?? fallback, mode: "openai" };
}

app.post<{ Body: { candidateId?: number; resumeText?: string } }>("/api/assist/resume-summary", { preHandler: requireAuth }, async (request, reply) => {
  const candidate = request.body?.candidateId ? candidateFor(userId(request), Number(request.body.candidateId)) : undefined;
  if (request.body?.candidateId && !candidate) return reply.code(404).send({ error: "Candidate not found." });
  const text = normalize(request.body?.resumeText) || String(candidate?.resume_text ?? "");
  if (!text) return reply.code(400).send({ error: "Upload a resume or provide resumeText first." });
  const fallback = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).slice(0, 3).join(" ").slice(0, 700) || "No readable resume text was found.";
  try {
    return await aiDraft(`Create a concise factual resume summary using only the text below. Include specialty, experience, locations, licenses mentioned, and gaps that need recruiter verification. Do not make a hiring decision.\n\n${text.slice(0, 12_000)}`, fallback);
  } catch (error) {
    app.log.warn({ err: error }, "AI summary unavailable; using local fallback");
    return { text: fallback, mode: "local-fallback", note: "AI service unavailable." };
  }
});

app.post<{ Body: { jobId?: number; candidateId?: number } }>("/api/assist/screening-questions", { preHandler: requireAuth }, async (request, reply) => {
  const job = request.body?.jobId ? jobFor(userId(request), Number(request.body.jobId)) : undefined;
  const candidate = request.body?.candidateId ? candidateFor(userId(request), Number(request.body.candidateId)) : undefined;
  if (request.body?.jobId && !job) return reply.code(404).send({ error: "Job not found." });
  if (request.body?.candidateId && !candidate) return reply.code(404).send({ error: "Candidate not found." });
  const fallback = [
    "Which states are you currently licensed in, and are any applications pending?",
    `What availability do you have for ${job ? String(job.title) : "the role"}?`,
    "What experience should the hiring team understand that is most relevant to this role?",
    "What location, schedule, and contract preferences should we consider?",
    "Is there anything in your credentials or availability that needs follow-up verification?"
  ].join("\n");
  try {
    return await aiDraft(`Draft five neutral screening questions for this physician role. Ask only for information that needs recruiter confirmation; do not infer credentials or assess protected traits. Role: ${job ? `${job.title}, ${job.specialty}, ${job.location}` : "unspecified"}. Candidate context: ${candidate ? `${candidate.specialty}, ${candidate.location}` : "unspecified"}. Return one question per line.`, fallback);
  } catch (error) {
    app.log.warn({ err: error }, "AI questions unavailable; using local fallback");
    return { text: fallback, mode: "local-fallback", note: "AI service unavailable." };
  }
});

async function googleAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`Google OAuth returned ${response.status}.`);
  const result = await response.json() as { access_token?: string };
  return result.access_token ?? null;
}

app.post<{ Params: { id: string }; Body: { startsAt?: string; durationMinutes?: number; title?: string } }>("/api/candidates/:id/meetings", { preHandler: requireAuth }, async (request, reply) => {
  const user = userId(request);
  const candidate = candidateFor(user, Number(request.params.id));
  if (!candidate) return reply.code(404).send({ error: "Candidate not found." });
  const startsAt = new Date(String(request.body?.startsAt ?? ""));
  if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() < Date.now()) return reply.code(400).send({ error: "Choose a future start time." });
  const duration = Math.max(15, Math.min(120, Number(request.body?.durationMinutes) || 30));
  const endsAt = new Date(startsAt.getTime() + duration * 60_000);
  const title = normalize(request.body?.title) || `Recruiter screen — ${candidate.name}`;
  // Calendar is optional. Without it, create an unguessable Jitsi room so both sides
  // still have a concrete video link to join from their dashboards.
  let meetUrl = `https://meet.jit.si/medrecruit-${randomUUID()}`;
  let provider = "jitsi";
  let calendarEventId: string | null = null;
  let calendarEventUrl: string | null = null;
  let scheduled = false;
  try {
    const token = await googleAccessToken();
    if (token) {
      const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID ?? "primary");
      const eventResponse = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=1&sendUpdates=all`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ summary: title, start: { dateTime: startsAt.toISOString() }, end: { dateTime: endsAt.toISOString() }, attendees: candidate.email ? [{ email: String(candidate.email) }] : [], conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } })
      });
      if (!eventResponse.ok) throw new Error(`Google Calendar returned ${eventResponse.status}.`);
      let event = await eventResponse.json() as { id?: string; htmlLink?: string; conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> } };
      calendarEventId = event.id ?? null;
      calendarEventUrl = event.htmlLink ?? null;
      scheduled = true;
      provider = "google_calendar";
      meetUrl = event.conferenceData?.entryPoints?.find((item) => item.entryPointType === "video")?.uri ?? meetUrl;
      if (meetUrl.endsWith("/new") && event.id) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 900));
        const retry = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(event.id)}?conferenceDataVersion=1`, { headers: { Authorization: `Bearer ${token}` } });
        if (retry.ok) {
          event = await retry.json() as typeof event;
          calendarEventUrl = event.htmlLink ?? calendarEventUrl;
          meetUrl = event.conferenceData?.entryPoints?.find((item) => item.entryPointType === "video")?.uri ?? meetUrl;
        }
      }
    }
  } catch (error) {
    app.log.warn({ err: error }, "Calendar event could not be scheduled");
    return reply.code(502).send({ error: "Google Calendar could not create the meeting. Check OAuth setup and Calendar API access." });
  }
  run("INSERT INTO meetings (user_id, candidate_id, title, starts_at, meet_url, calendar_event_id, calendar_event_url, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [user, Number(candidate.id), title, startsAt.toISOString(), meetUrl, calendarEventId, calendarEventUrl, provider, new Date().toISOString()]);
  const meetingId = newId();
  run("UPDATE applications SET status = 'Interview', updated_at = ? WHERE candidate_id = ?", [new Date().toISOString(), Number(candidate.id)]);
  persist();
  const meetReady = !meetUrl.endsWith("/new");
  const note = scheduled
    ? meetReady ? undefined : "Calendar event scheduled; Google is still generating its Meet link. Open the event in Calendar to check again."
    : "A Jitsi video room was created. The doctor can join from their application dashboard; no Calendar setup is needed.";
  return reply.code(201).send({ meeting: { id: meetingId, title, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), meetUrl, meetReady, scheduled: true, provider, calendarEventId, calendarEventUrl, note } });
});

app.get("/api/meetings", { preHandler: requireAuth }, async (request) => {
  return rows<Record<string, unknown>>("SELECT meetings.*, candidates.name AS candidate_name FROM meetings JOIN candidates ON candidates.id=meetings.candidate_id WHERE meetings.user_id=? ORDER BY starts_at DESC", [userId(request)]);
});

const port = Number(process.env.PORT ?? 4000);
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be set in the root .env with at least 32 characters.");
try {
  await app.listen({ port, host: "127.0.0.1" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
