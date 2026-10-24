"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type User = { id: number; name: string; email: string; company_name?: string; recruiter_role?: string; onboardingCompleted: boolean };
type Job = { id: number; title: string; specialty: string; location: string; description: string; requiredLicenses: string[]; status: string };
type Candidate = { id: number; name: string; email?: string; specialty: string; location: string; licenseStates: string[]; availability: string; experience_years: number; stage: string; resumeAvailable: boolean; application_job_title?: string };
type Match = { candidate: Candidate; fitScore: number; eligible: boolean; reasons: string[]; gaps: string[] };
type Meeting = { id: number; title: string; starts_at: string; meet_url: string; candidate_name: string };
type Tab = "roles" | "candidates" | "shortlist" | "meetings";

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, credentials: "include", headers: { ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [authMode, setAuthMode] = useState<"signup" | "login">("signup");
  const [tab, setTab] = useState<Tab>("roles");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedJob, setSelectedJob] = useState<number | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [assistText, setAssistText] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [jobData, candidateData, meetingData] = await Promise.all([
      api<Job[]>("/api/jobs"), api<Candidate[]>("/api/candidates"), api<Meeting[]>("/api/meetings")
    ]);
    setJobs(jobData); setCandidates(candidateData); setMeetings(meetingData);
    setSelectedJob((current) => current ?? jobData[0]?.id ?? null);
    setSelectedCandidate((current) => current ?? candidateData[0]?.id ?? null);
  }, []);

  useEffect(() => {
    api<{ user: User | null }>("/api/auth/me").then((data) => {
      if (data.user) setUser(data.user);
    }).catch(() => {}).finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (user?.onboardingCompleted) refresh().catch((e: Error) => setError(e.message));
  }, [user, refresh]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api<{ user: User }>(`/api/auth/${authMode}`, { method: "POST", body: JSON.stringify(data) });
      setUser(result.user); setNotice(authMode === "signup" ? "Account created. Finish onboarding to open your ATS." : "Welcome back.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function submitOnboarding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api<{ user: User }>("/api/onboarding", { method: "POST", body: JSON.stringify(data) });
      setUser(result.user); setNotice("Workspace ready. Add your first role or candidate.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function createJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = event.currentTarget;
    const raw = Object.fromEntries(new FormData(form));
    try {
      const job = await api<Job>("/api/jobs", { method: "POST", body: JSON.stringify({ ...raw, requiredLicenses: String(raw.requiredLicenses ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean) }) });
      await refresh(); setSelectedJob(job.id); setNotice("Role added to your ATS."); form.reset();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function createCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = event.currentTarget;
    const raw = Object.fromEntries(new FormData(form));
    const file = (form.elements.namedItem("resume") as HTMLInputElement).files?.[0];
    try {
      const candidate = await api<Candidate>("/api/candidates", { method: "POST", body: JSON.stringify({ ...raw, licenseStates: String(raw.licenseStates ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean) }) });
      if (file) { const upload = new FormData(); upload.append("resume", file); await api(`/api/candidates/${candidate.id}/resume`, { method: "POST", body: upload }); }
      await refresh(); setSelectedCandidate(candidate.id); setNotice(file ? "Candidate and resume added." : "Candidate added."); form.reset();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function runShortlist() {
    if (!selectedJob) return;
    setBusy(true); setError("");
    try { const result = await api<{ results: Match[] }>(`/api/jobs/${selectedJob}/shortlist`, { method: "POST", body: "{}" }); setMatches(result.results); setTab("shortlist"); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function assist(kind: "resume-summary" | "screening-questions") {
    setBusy(true); setError(""); setAssistText("");
    try {
      const result = await api<{ text: string; mode: string; note?: string }>(`/api/assist/${kind}`, { method: "POST", body: JSON.stringify(kind === "resume-summary" ? { candidateId: selectedCandidate } : { candidateId: selectedCandidate, jobId: selectedJob }) });
      setAssistText(`${result.text}\n\nDraft source: ${result.mode}${result.note ? ` · ${result.note}` : ""}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function createMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selectedCandidate) return;
    const data = Object.fromEntries(new FormData(event.currentTarget)); setBusy(true); setError("");
    try {
      const result = await api<{ meeting: { meetUrl: string; scheduled: boolean; meetReady: boolean; calendarEventUrl?: string | null; note?: string } }>(`/api/candidates/${selectedCandidate}/meetings`, { method: "POST", body: JSON.stringify({ ...data, startsAt: new Date(String(data.startsAt)).toISOString() }) });
      setNotice(result.meeting.scheduled ? (result.meeting.meetReady ? "Calendar event and Meet link created." : `${result.meeting.note ?? "Meet link is pending."} ${result.meeting.calendarEventUrl ?? ""}`) : `${result.meeting.note} ${result.meeting.meetUrl}`);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function changeStage(candidate: Candidate, stage: string) {
    try { await api(`/api/candidates/${candidate.id}/stage`, { method: "PATCH", body: JSON.stringify({ stage }) }); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }

  async function changeJobStatus(job: Job) {
    const status = job.status === "Open" ? "Closed" : "Open";
    setBusy(true); setError("");
    try {
      await api(`/api/jobs/${job.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refresh(); setNotice(status === "Closed" ? "Role closed. Doctor applications are now marked expired." : "Role reopened. New applications can be submitted.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {}); setUser(null); setJobs([]); setCandidates([]); setMeetings([]);
  }

  if (checking) return <main className="center-screen"><div className="loader" />Opening local MedRecruit…</main>;
  if (!user) return <main className="auth-shell"><section className="auth-brand"><div className="brand"><span className="brand-mark">M</span> MedRecruit</div><div className="auth-pitch"><p className="eyebrow">PHYSICIAN TALENT WORKSPACE</p><h1>Find the right physician.<br /><em>Show your work.</em></h1><p>A focused ATS for roles, resume evidence, shortlists, and recruiter-led screening.</p><div className="pitch-tags"><span>Local-first</span><span>Evidence-based</span><span>Recruiter controlled</span></div></div><small>Local prototype · fictional demo data recommended</small></section><section className="auth-panel"><form className="auth-card" onSubmit={submitAuth}><p className="eyebrow">{authMode === "signup" ? "GET STARTED" : "WELCOME BACK"}</p><h2>{authMode === "signup" ? "Create your workspace" : "Sign in to MedRecruit"}</h2><p className="muted">Your account and ATS data stay in this local app.</p>{authMode === "signup" && <label>Your name<input name="name" autoComplete="name" required minLength={2} placeholder="Jordan Lee" /></label>}<label>Work email<input name="email" type="email" autoComplete="email" required placeholder="jordan@clinic.com" /></label><label>Password<input name="password" type="password" autoComplete={authMode === "signup" ? "new-password" : "current-password"} required minLength={authMode === "signup" ? 10 : 1} placeholder={authMode === "signup" ? "At least 10 characters" : "Your password"} /></label><button className="button primary full" disabled={busy}>{busy ? "Please wait…" : authMode === "signup" ? "Create account" : "Sign in"}</button>{error && <p className="error">{error}</p>}<p className="switch-auth">{authMode === "signup" ? "Already have an account?" : "New to MedRecruit?"} <button type="button" className="link-button" onClick={() => { setAuthMode(authMode === "signup" ? "login" : "signup"); setError(""); }}>{authMode === "signup" ? "Sign in" : "Create an account"}</button></p></form><p className="switch-auth">Are you a physician? <a className="link-button" href="/doctor">Browse and apply to roles</a></p></section></main>;

  if (!user.onboardingCompleted) return <main className="onboarding-shell"><div className="brand"><span className="brand-mark">M</span> MedRecruit</div><form className="onboarding-card" onSubmit={submitOnboarding}><div className="step-chip">STEP 1 OF 1 · WORKSPACE SETUP</div><h1>Let’s set up your recruiting workspace.</h1><p className="muted">Tell us how your team works. You can keep this to your own local account for now.</p><label>Company or team name<input name="companyName" required minLength={2} placeholder="Northstar Physician Staffing" /></label><label>Your role<select name="recruiterRole" defaultValue="recruiter"><option value="recruiter">Recruiter</option><option value="sourcing_lead">Sourcing lead</option><option value="staffing_manager">Staffing manager</option><option value="hiring_manager">Hiring manager</option></select></label><button className="button primary" disabled={busy}>{busy ? "Saving…" : "Finish setup →"}</button>{error && <p className="error">{error}</p>}<button type="button" className="link-button signout-link" onClick={logout}>Sign out</button></form></main>;

  return <main className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">M</span> MedRecruit</div><div className="workspace-label">YOUR WORKSPACE</div><div className="workspace-name">{user.company_name}</div><nav>{([{ id: "roles", icon: "▤", label: "Roles" }, { id: "candidates", icon: "♙", label: "Candidates" }, { id: "shortlist", icon: "✦", label: "Shortlist" }, { id: "meetings", icon: "◷", label: "Screenings" }] as const).map((item) => <button key={item.id} className={`nav-item ${tab === item.id ? "active" : ""}`} onClick={() => setTab(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-foot"><div className="user-avatar">{user.name.slice(0, 1).toUpperCase()}</div><div className="user-detail"><strong>{user.name}</strong><small>{user.recruiter_role?.replaceAll("_", " ")}</small></div><button className="logout" title="Sign out" onClick={logout}>↪</button></div></aside>
    <section className="main-area"><header className="topbar"><div><span className="breadcrumb">{user.company_name}</span><span className="crumb-sep">/</span><strong>{tab === "roles" ? "Roles" : tab === "candidates" ? "Candidates" : tab === "shortlist" ? "Shortlist" : "Screenings"}</strong></div><div style={{ display: "flex", alignItems: "center", gap: 12 }}><a className="link-button" href="/doctor">Doctor portal</a><div className="local-pill"><span /> Local workspace</div></div></header><div className="page-wrap"><div className="page-heading"><div><p className="eyebrow">PHYSICIAN RECRUITING · ATS</p><h1>{tab === "roles" ? "Roles" : tab === "candidates" ? "Candidate ATS" : tab === "shortlist" ? "Evidence shortlist" : "Screening meetings"}</h1><p className="muted">{tab === "roles" ? "Define a role, then find relevant candidate evidence." : tab === "candidates" ? "Keep resumes, credentials, availability, and pipeline stage together." : tab === "shortlist" ? "Transparent role fit, evidence, and verification gaps." : "Book a recruiter screen and keep the meeting with the candidate record."}</p></div>{tab === "roles" && <button className="button primary" onClick={() => document.getElementById("new-role")?.scrollIntoView({ behavior: "smooth" })}>＋ Add role</button>}{tab === "candidates" && <button className="button primary" onClick={() => document.getElementById("new-candidate")?.scrollIntoView({ behavior: "smooth" })}>＋ Add candidate</button>}</div>
    {notice && <div className="notice" onClick={() => setNotice("")}>{notice}<button aria-label="Dismiss">×</button></div>}{error && <div className="alert" onClick={() => setError("")}>{error}<button aria-label="Dismiss">×</button></div>}
    <div className="summary-grid"><div className="summary-card"><span className="summary-icon teal">▤</span><div><strong>{jobs.length}</strong><small>Roles</small></div></div><div className="summary-card"><span className="summary-icon violet">♙</span><div><strong>{candidates.length}</strong><small>Candidates</small></div></div><div className="summary-card"><span className="summary-icon amber">✦</span><div><strong>{matches.filter((m) => m.eligible).length}</strong><small>Eligible shortlist</small></div></div><div className="summary-card"><span className="summary-icon blue">◷</span><div><strong>{meetings.length}</strong><small>Screenings booked</small></div></div></div>

    {tab === "roles" && <div className="two-column"><section className="panel"><div className="panel-heading"><div><h2>Roles</h2><p>Select a role to build its shortlist or close applications.</p></div><span className="count-badge">{jobs.length}</span></div>{jobs.length ? <div className="role-list">{jobs.map((job) => <div key={job.id} style={{ display: "flex", alignItems: "center", gap: 8 }}><button className={`role-row ${selectedJob === job.id ? "selected" : ""}`} style={{ flex: 1, width: "auto" }} onClick={() => setSelectedJob(job.id)}><span className="role-symbol">✚</span><span className="role-info"><strong>{job.title}</strong><small>{job.specialty} · {job.location}</small><em>{job.requiredLicenses.length ? `${job.requiredLicenses.length} required license item${job.requiredLicenses.length > 1 ? "s" : ""}` : "No required license filters"} · {job.status}</em></span><span className="chevron">›</span></button><button className="link-button" disabled={busy} onClick={() => changeJobStatus(job)}>{job.status === "Open" ? "Close" : "Reopen"}</button></div>)}</div> : <div className="empty"><div>▤</div><strong>No roles yet</strong><span>Add a role to start sourcing.</span></div>}<button className="button outline full" onClick={runShortlist} disabled={!selectedJob || busy}>✦ Build evidence shortlist</button></section><form id="new-role" className="panel form-panel" onSubmit={createJob}><div className="panel-heading"><div><h2>Create a role</h2><p>Start with the essentials. Tune criteria later.</p></div></div><label>Role title<input name="title" required placeholder="Cardiologist — locum tenens" /></label><div className="field-row"><label>Specialty<input name="specialty" required placeholder="Cardiology" /></label><label>Location<input name="location" required placeholder="Raleigh, NC" /></label></div><label>Required license states <span className="optional">Optional</span><input name="requiredLicenses" placeholder="NC, SC (comma separated)" /></label><label>Role notes<textarea name="description" rows={3} placeholder="Schedule, experience, coverage details…" /></label><button className="button primary full" disabled={busy}>{busy ? "Saving…" : "Save role"}</button></form></div>}

    {tab === "candidates" && <div className="two-column"><section className="panel"><div className="panel-heading"><div><h2>Candidate records</h2><p>Resume evidence stays in local storage.</p></div><span className="count-badge">{candidates.length}</span></div>{candidates.length ? <div className="candidate-list">{candidates.map((candidate) => <div className={`candidate-row ${selectedCandidate === candidate.id ? "selected" : ""}`} key={candidate.id} onClick={() => setSelectedCandidate(candidate.id)}><span className="candidate-avatar">{candidate.name.slice(0, 1).toUpperCase()}</span><span className="candidate-info"><strong>{candidate.name}</strong><small>{candidate.application_job_title ? `Application: ${candidate.application_job_title}` : `${candidate.specialty || "Specialty not recorded"} · ${candidate.location || "Location not recorded"}`}</small></span><select aria-label={`Stage for ${candidate.name}`} value={candidate.stage} onClick={(e) => e.stopPropagation()} onChange={(e) => changeStage(candidate, e.target.value)}>{["New", "Contacted", "Interested", "Screening", "Submitted", "Interview", "Offer", "Placed", "Rejected", "Expired", "Archived"].map((stage) => <option key={stage}>{stage}</option>)}</select></div>)}</div> : <div className="empty"><div>♙</div><strong>No candidates yet</strong><span>Add a candidate and attach their resume.</span></div>}{selectedCandidate && <div className="assist-card"><div className="assist-head"><div><strong>Recruiter copilot</strong><small>Draft only · review before sharing</small></div><span>✦</span></div><div className="button-row"><button className="button outline" onClick={() => assist("resume-summary")} disabled={busy}>Summarize resume</button><button className="button outline" onClick={() => assist("screening-questions")} disabled={busy}>Draft screen questions</button></div>{assistText && <pre className="assist-output">{assistText}</pre>}</div>}</section><form id="new-candidate" className="panel form-panel" onSubmit={createCandidate}><div className="panel-heading"><div><h2>Add a candidate</h2><p>Upload a resume or add profile details first.</p></div></div><label>Full name<input name="name" required placeholder="Dr. Taylor Morgan" /></label><label>Email <span className="optional">Optional</span><input name="email" type="email" placeholder="taylor@example.com" /></label><div className="field-row"><label>Specialty<input name="specialty" placeholder="Cardiology" /></label><label>Location<input name="location" placeholder="Raleigh, NC" /></label></div><label>License states <span className="optional">Comma separated</span><input name="licenseStates" placeholder="NC, VA" /></label><div className="field-row"><label>Availability<input name="availability" placeholder="Weekdays, starts June" /></label><label>Years experience<input name="experienceYears" type="number" min="0" max="60" defaultValue="0" /></label></div><label>Resume <span className="optional">PDF, DOCX, or TXT · 12 MB max</span><input className="file-input" type="file" name="resume" accept=".pdf,.docx,.txt" /></label><label>Source<input name="source" placeholder="Referral, inbound, opted-in list…" /></label><button className="button primary full" disabled={busy}>{busy ? "Saving…" : "Save candidate"}</button></form></div>}

    {tab === "shortlist" && <section className="panel"><div className="panel-heading shortlist-heading"><div><h2>Role shortlist</h2><p>Eligibility gates: specialty and any role-required licenses. Score factors stay visible.</p></div><div className="select-row"><select value={selectedJob ?? ""} onChange={(e) => setSelectedJob(Number(e.target.value) || null)}><option value="">Choose a role</option>{jobs.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}</select><button className="button primary" disabled={!selectedJob || busy} onClick={runShortlist}>Refresh shortlist</button></div></div><div className="score-key"><span>Specialty 35</span><span>Licenses 25</span><span>Location 15</span><span>Availability 10</span><span>Resume evidence 5</span><span>Experience 10</span></div>{matches.length ? <div className="match-list">{matches.map((match) => <article className="match-card" key={match.candidate.id}><div className="match-top"><span className="candidate-avatar">{match.candidate.name.slice(0, 1).toUpperCase()}</span><div className="candidate-info"><strong>{match.candidate.name}</strong><small>{match.candidate.specialty || "Specialty missing"} · {match.candidate.location || "Location missing"}</small></div><span className={`eligibility ${match.eligible ? "eligible" : "review"}`}>{match.eligible ? "Eligible to review" : "Needs verification"}</span><strong className="score">{match.fitScore}<small>/100</small></strong></div><div className="match-details"><div><strong>Evidence</strong>{match.reasons.length ? match.reasons.map((reason) => <p key={reason}>✓ {reason}</p>) : <p>No supporting evidence recorded yet.</p>}</div><div><strong>Follow-up gaps</strong>{match.gaps.length ? match.gaps.map((gap) => <p key={gap}>! {gap}</p>) : <p>No score gaps found; verify credentials before submission.</p>}</div></div></article>)}</div> : <div className="empty"><div>✦</div><strong>Build a shortlist</strong><span>Select a role and run the evidence-based match.</span><button className="button outline" disabled={!selectedJob || busy} onClick={runShortlist}>Run matching</button></div>}</section>}

    {tab === "meetings" && <div className="two-column"><form className="panel form-panel" onSubmit={createMeeting}><div className="panel-heading"><div><h2>Schedule a recruiter screen</h2><p>A Calendar invite and Meet room are created when Google OAuth is configured.</p></div></div><label>Candidate<select value={selectedCandidate ?? ""} onChange={(e) => setSelectedCandidate(Number(e.target.value) || null)} required><option value="">Choose candidate</option>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><label>Start time<input type="datetime-local" name="startsAt" required min={new Date(Date.now() + 60000).toISOString().slice(0, 16)} /></label><div className="field-row"><label>Duration<select name="durationMinutes" defaultValue="30"><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">60 minutes</option></select></label><label>Meeting title<input name="title" placeholder="Recruiter screen" /></label></div><button className="button primary full" disabled={!selectedCandidate || busy}>{busy ? "Creating…" : "Create meeting link"}</button><p className="form-hint">If Google Calendar isn’t configured, this returns a quick-join link and marks it unscheduled.</p></form><section className="panel"><div className="panel-heading"><div><h2>Upcoming screens</h2><p>Meetings saved with their candidate.</p></div><span className="count-badge">{meetings.length}</span></div>{meetings.length ? <div className="meeting-list">{meetings.map((meeting) => <article className="meeting-row" key={meeting.id}><span className="summary-icon blue">◷</span><div className="candidate-info"><strong>{meeting.title}</strong><small>{meeting.candidate_name} · {new Date(meeting.starts_at).toLocaleString()}</small></div><a className="button outline" href={meeting.meet_url} target="_blank" rel="noreferrer">Open Meet ↗</a></article>)}</div> : <div className="empty"><div>◷</div><strong>No meetings yet</strong><span>Create a screen to keep the link with its candidate.</span></div>}</section></div>}
    <footer className="app-footer">MedRecruit local MVP <span>·</span> Fictional sample data recommended <span>·</span> AI drafts are not hiring decisions</footer></div></section></main>;
}
