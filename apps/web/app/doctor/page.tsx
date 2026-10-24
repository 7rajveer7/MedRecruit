"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import "./doctor.css";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Doctor = { id: number; name: string; email: string; specialty: string; location: string; licenseStates: string[]; availability: string; experience_years: number; resume_filename?: string | null; hasResume: boolean };
type Job = { id: number; title: string; specialty: string; location: string; description: string; requiredLicenses: string[]; companyName: string; status: string };
type Meeting = { id: number; title: string; startsAt: string; meetUrl: string; calendarEventUrl: string | null; scheduled: boolean; meetReady: boolean };
type Application = { id: number; status: string; appliedAt: string; updatedAt: string; job: Job; meetings: Meeting[] };
type Tab = "roles" | "applications" | "profile";

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

function emptyProfile(doctor?: Doctor | null) {
  return {
    specialty: doctor?.specialty ?? "",
    location: doctor?.location ?? "",
    licenseStates: doctor?.licenseStates.join(", ") ?? "",
    availability: doctor?.availability ?? "",
    experienceYears: doctor?.experience_years ?? 0
  };
}

function statusClass(status: string) {
  return status.toLowerCase().replaceAll(" ", "-");
}

export default function DoctorPortal() {
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [profile, setProfile] = useState(emptyProfile());
  const [tab, setTab] = useState<Tab>("roles");
  const [authMode, setAuthMode] = useState<"signup" | "login">("signup");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [targetJob, setTargetJob] = useState<number | null>(null);

  const loadJobs = useCallback(async () => {
    setJobs(await api<Job[]>("/api/public/jobs"));
  }, []);

  const loadApplications = useCallback(async () => {
    setApplications(await api<Application[]>("/api/doctor/applications"));
  }, []);

  useEffect(() => {
    Promise.all([
      loadJobs(),
      api<{ doctor: Doctor }>("/api/doctor/auth/me").then(async ({ doctor: current }) => {
        setDoctor(current);
        setProfile(emptyProfile(current));
        await loadApplications();
      }).catch(() => {})
    ]).catch((cause) => setError((cause as Error).message)).finally(() => setChecking(false));
  }, [loadApplications, loadJobs]);

  useEffect(() => {
    if (!doctor) return;
    const timer = window.setInterval(() => loadApplications().catch(() => {}), 20_000);
    return () => window.clearInterval(timer);
  }, [doctor, loadApplications]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      const result = await api<{ doctor: Doctor }>(`/api/doctor/auth/${authMode}`, { method: "POST", body: JSON.stringify(data) });
      setDoctor(result.doctor);
      setProfile(emptyProfile(result.doctor));
      await loadApplications();
      setNotice(authMode === "signup" ? "Account created. Finish your profile to apply." : `Welcome back, Dr. ${result.doctor.name}.`);
      if (!result.doctor.hasResume || !result.doctor.specialty) setTab("profile");
      else if (targetJob) await applyToRole(targetJob, true);
      form.reset();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function applyToRole(jobId: number, profileReady = Boolean(doctor?.hasResume && doctor?.specialty)) {
    if (!doctor) {
      setTargetJob(jobId); setAuthMode("signup"); setError("Create a doctor account or sign in to apply.");
      document.getElementById("doctor-auth")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (!profileReady) {
      setTargetJob(jobId); setTab("profile"); setError("Complete your profile and upload a resume before applying.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      await api(`/api/public/jobs/${jobId}/applications`, { method: "POST", body: "{}" });
      await Promise.all([loadApplications(), loadJobs()]);
      setTargetJob(null); setTab("applications"); setNotice("Application submitted. You can track updates here.");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    const form = event.currentTarget;
    const file = (form.elements.namedItem("resume") as HTMLInputElement).files?.[0];
    try {
      const result = await api<{ doctor: Doctor }>("/api/doctor/profile", {
        method: "PATCH",
        body: JSON.stringify({ ...profile, licenseStates: profile.licenseStates.split(/[,;]/).map((value) => value.trim()).filter(Boolean) })
      });
      let savedDoctor = result.doctor;
      if (file) {
        const upload = new FormData(); upload.append("resume", file);
        savedDoctor = (await api<{ doctor: Doctor }>("/api/doctor/profile/resume", { method: "POST", body: upload })).doctor;
      }
      setDoctor(savedDoctor); setProfile(emptyProfile(savedDoctor));
      setNotice("Profile saved. Your resume is ready to use for applications.");
      if (targetJob && savedDoctor.hasResume && savedDoctor.specialty) await applyToRole(targetJob, true);
      else form.reset();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setDoctor(null); setApplications([]); setTab("roles"); setNotice("You have signed out.");
  }

  const upcomingMeetings = applications.flatMap((application) => application.meetings.map((meeting) => ({ ...meeting, roleTitle: application.job.title, companyName: application.job.companyName, status: application.status })));

  if (checking) return <main className="center-screen"><div className="loader" />Opening doctor portal…</main>;

  return <main className="doctor-shell">
    <header className="doctor-topbar">
      <a className="brand" href="/"><span className="brand-mark">M</span> MedRecruit</a>
      <div className="doctor-top-actions"><span className="doctor-audience">Physician portal</span><a className="link-button" href="/">Recruiter sign in</a></div>
    </header>

    {!doctor ? <div className="doctor-public-layout">
      <section className="doctor-openings">
        <p className="eyebrow">PHYSICIAN OPPORTUNITIES</p>
        <h1>Find your next role.</h1>
        <p className="muted">Explore open roles and apply with your profile and resume. Sign in to track every application.</p>
        <div className="doctor-job-list">{jobs.length ? jobs.map((job) => <article className="doctor-job-card" key={job.id}>
          <div className="doctor-job-meta"><span>{job.companyName}</span><span>{job.location}</span></div>
          <h2>{job.title}</h2><p className="doctor-specialty">{job.specialty}</p>
          {job.description && <p className="doctor-description">{job.description}</p>}
          {!!job.requiredLicenses.length && <p className="doctor-requirement"><strong>License states:</strong> {job.requiredLicenses.join(", ")}</p>}
          <button className="button primary" onClick={() => applyToRole(job.id)} disabled={busy}>Apply to this role</button>
        </article>) : <div className="doctor-empty">No open roles are listed right now. Check again soon.</div>}</div>
      </section>
      <section className="panel doctor-auth-panel" id="doctor-auth">
        <p className="eyebrow">{authMode === "signup" ? "DOCTOR ACCOUNT" : "WELCOME BACK"}</p>
        <h2>{authMode === "signup" ? "Create your account" : "Sign in to your dashboard"}</h2>
        <p className="muted">Your dashboard keeps your applications and interview details together.</p>
        <form className="doctor-form" onSubmit={submitAuth}>
          {authMode === "signup" && <label>Full name<input name="name" autoComplete="name" required minLength={2} placeholder="Dr. Jordan Lee" /></label>}
          <label>Email<input name="email" type="email" autoComplete="email" required placeholder="you@example.com" /></label>
          <label>Password<input name="password" type="password" autoComplete={authMode === "signup" ? "new-password" : "current-password"} minLength={authMode === "signup" ? 10 : 1} required placeholder={authMode === "signup" ? "At least 10 characters" : "Your password"} /></label>
          <button className="button primary full" disabled={busy}>{busy ? "Please wait…" : authMode === "signup" ? "Create doctor account" : "Sign in"}</button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="switch-auth">{authMode === "signup" ? "Already have a doctor account?" : "New here?"} <button className="link-button" onClick={() => { setAuthMode(authMode === "signup" ? "login" : "signup"); setError(""); }}>{authMode === "signup" ? "Sign in" : "Create an account"}</button></p>
        <p className="doctor-privacy-note">For this local prototype, use fictional details and a sample resume.</p>
      </section>
    </div> : <>
      <section className="doctor-dashboard-heading">
        <div><p className="eyebrow">PHYSICIAN DASHBOARD</p><h1>Welcome, {doctor.name}</h1><p className="muted">Track your applications and recruiter messages in one place.</p></div>
        <button className="button outline" onClick={logout}>Sign out</button>
      </section>
      <div className="doctor-dashboard-body">
        <nav className="doctor-tabs" aria-label="Doctor dashboard">
          {([{ id: "roles", label: "Find roles" }, { id: "applications", label: `My applications${applications.length ? ` (${applications.length})` : ""}` }, { id: "profile", label: "My profile" }] as const).map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => { setTab(item.id); setError(""); }} aria-current={tab === item.id ? "page" : undefined}>{item.label}</button>)}
        </nav>
        {notice && <div className="notice" role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice("")}>×</button></div>}
        {error && <div className="alert" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}

        {tab === "roles" && <section>
          <div className="doctor-section-heading"><div><h2>Open opportunities</h2><p>Applying sends your profile and current resume to the recruiting team.</p></div><span className="count-badge">{jobs.length}</span></div>
          <div className="doctor-job-list dashboard-jobs">{jobs.length ? jobs.map((job) => {
            const alreadyApplied = applications.some((application) => application.job.id === job.id);
            return <article className="doctor-job-card" key={job.id}><div className="doctor-job-meta"><span>{job.companyName}</span><span>{job.location}</span></div><h2>{job.title}</h2><p className="doctor-specialty">{job.specialty}</p>{job.description && <p className="doctor-description">{job.description}</p>}{!!job.requiredLicenses.length && <p className="doctor-requirement"><strong>License states:</strong> {job.requiredLicenses.join(", ")}</p>}<button className="button primary" disabled={busy || alreadyApplied} onClick={() => applyToRole(job.id)}>{alreadyApplied ? "Application submitted" : busy ? "Please wait…" : "Apply to this role"}</button></article>;
          }) : <div className="doctor-empty">No open roles are listed right now. Check again soon.</div>}</div>
        </section>}

        {tab === "applications" && <section>
          <div className="doctor-section-heading"><div><h2>My applications</h2><p>Status updates refresh automatically while this dashboard is open.</p></div><button className="button outline" onClick={() => loadApplications().catch((cause) => setError((cause as Error).message))}>Refresh</button></div>
          {upcomingMeetings.length > 0 && <div className="doctor-meeting-alert" role="status"><span className="meeting-alert-icon">◷</span><div><strong>You have an interview update</strong><p>Open an application below for the meeting time and join details.</p></div></div>}
          {applications.length ? <div className="doctor-application-list">{applications.map((application) => <article className="doctor-application-card" key={application.id}>
            <div className="doctor-application-top"><div><p className="doctor-job-meta">{application.job.companyName} · {application.job.location}</p><h3>{application.job.title}</h3><p className="doctor-specialty">{application.job.specialty}</p></div><span className={`doctor-status status-${statusClass(application.status)}`}>{application.status}</span></div>
            <div className="doctor-application-foot"><span>Applied {new Date(application.appliedAt).toLocaleDateString()}</span><span>Updated {new Date(application.updatedAt).toLocaleDateString()}</span><span>{application.job.status === "Closed" ? "Role closed" : "Role open"}</span></div>
            {application.meetings.map((meeting) => <div className="doctor-meeting-card" key={meeting.id}><div><strong>{meeting.scheduled ? "Interview invitation" : "Recruiter screen update"}</strong><p>{meeting.title} · {new Date(meeting.startsAt).toLocaleString()}</p>{meeting.scheduled && !meeting.meetReady && <p>The calendar event is ready; the Meet link may still be generating.</p>}{!meeting.scheduled && <p>The recruiter saved a screen request. The calendar invite is not scheduled yet.</p>}</div>{meeting.meetReady && <a className="button primary" href={meeting.meetUrl} target="_blank" rel="noreferrer">Join Google Meet ↗</a>}{meeting.calendarEventUrl && <a className="button outline" href={meeting.calendarEventUrl} target="_blank" rel="noreferrer">Open calendar ↗</a>}</div>)}
          </article>)}</div> : <div className="doctor-empty"><strong>No applications yet</strong><p>Browse open roles and apply to see your progress here.</p><button className="button outline" onClick={() => setTab("roles")}>Find open roles</button></div>}
        </section>}

        {tab === "profile" && <section className="panel doctor-profile-panel">
          <div className="doctor-section-heading"><div><h2>My profile</h2><p>Keep these details and your resume current before applying.</p></div><span className={doctor.hasResume && doctor.specialty ? "profile-ready" : "profile-incomplete"}>{doctor.hasResume && doctor.specialty ? "Ready to apply" : "Complete profile"}</span></div>
          <form className="doctor-form profile-form" onSubmit={saveProfile}>
            <div className="profile-account"><strong>{doctor.name}</strong><span>{doctor.email}</span></div>
            <div className="field-row"><label>Medical specialty<input value={profile.specialty} onChange={(event) => setProfile({ ...profile, specialty: event.target.value })} required placeholder="Cardiology" /></label><label>Current location<input value={profile.location} onChange={(event) => setProfile({ ...profile, location: event.target.value })} placeholder="Raleigh, NC" /></label></div>
            <label>License states <span className="optional">Comma separated</span><input value={profile.licenseStates} onChange={(event) => setProfile({ ...profile, licenseStates: event.target.value })} placeholder="NC, VA" /></label>
            <div className="field-row"><label>Availability<input value={profile.availability} onChange={(event) => setProfile({ ...profile, availability: event.target.value })} placeholder="Weekdays, starts June" /></label><label>Years of experience<input type="number" min="0" max="60" value={profile.experienceYears} onChange={(event) => setProfile({ ...profile, experienceYears: Number(event.target.value) })} /></label></div>
            <label>Resume <span className="optional">PDF, DOCX, or TXT · 12 MB max</span><input className="file-input" type="file" name="resume" accept=".pdf,.docx,.txt" required={!doctor.hasResume} /></label>
            {doctor.hasResume && <p className="resume-current">Current resume: {doctor.resume_filename}</p>}
            <button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
          </form>
        </section>}
      </div>
    </>}
    <footer className="doctor-footer">MedRecruit physician portal <span>·</span> Use fictional data in this local demo</footer>
  </main>;
}
