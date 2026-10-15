"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, LiveReading, PcStatus, PresenceCurrent, PresenceEvent, api, errorText } from "@/lib/api";
import { useCalmReading } from "@/lib/calm";
import { DisplayTab } from "./display";
import { Overview } from "./overview";

type Auth = "loading" | "out" | "in";
type Tab = "overview" | "display";

const LIVE_POLL_MS = 1000;
const STATUS_POLL_MS = 5000;
const HISTORY_POLL_MS = 60000;
const LIVE_STALE_S = 6;

export default function Home() {
  const [auth, setAuth] = useState<Auth>("loading");

  useEffect(() => {
    api
      .me()
      .then(() => setAuth("in"))
      .catch(() => setAuth("out"));
  }, []);

  if (auth === "loading") return <main className="shell" />;
  if (auth === "out") return <Login onDone={() => setAuth("in")} />;
  return <Dashboard onLogout={() => setAuth("out")} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell login-shell">
      <form className="card login" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="wordmark">radarwake</span>
        </div>
        <div>
          <h1>Sign in</h1>
          <p className="muted">Available on the home network only.</p>
        </div>
        <label className="field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [status, setStatus] = useState<PcStatus | null>(null);
  const [presence, setPresence] = useState<PresenceCurrent | null>(null);
  const [live, setLive] = useState<LiveReading | null>(null);
  const [history, setHistory] = useState<PresenceEvent[]>([]);
  const [toastMsg, setToastMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("rw-tab");
      if (saved === "display" || saved === "overview") setTab(saved);
    } catch {}
  }, []);

  function selectTab(t: Tab) {
    setTab(t);
    try {
      localStorage.setItem("rw-tab", t);
    } catch {}
  }

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onLogout();
      else setOffline(true);
    },
    [onLogout],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.status(), api.presence()]);
      setStatus(s);
      setPresence(p);
      setOffline(false);
    } catch (err) {
      handleError(err);
    }
  }, [handleError]);

  const refreshLive = useCallback(async () => {
    try {
      setLive(await api.live());
      setOffline(false);
    } catch (err) {
      handleError(err);
    }
  }, [handleError]);

  const refreshHistory = useCallback(() => {
    api.history(24).then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    refreshLive();
    refreshHistory();
    const timers = [
      setInterval(() => document.visibilityState === "visible" && refreshLive(), LIVE_POLL_MS),
      setInterval(() => document.visibilityState === "visible" && refreshStatus(), STATUS_POLL_MS),
      setInterval(refreshHistory, HISTORY_POLL_MS),
    ];
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refreshStatus();
        refreshLive();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      timers.forEach(clearInterval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshStatus, refreshLive, refreshHistory]);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 4000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const toast = useCallback((text: string, error = false) => setToastMsg({ text, error }), []);

  async function run(label: string, fn: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await fn();
      toast(label);
      await refreshStatus();
    } catch (err) {
      toast(errorText(err), true);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api.logout().catch(() => {});
    onLogout();
  }

  const fresh = !!live && live.age_s < LIVE_STALE_S;
  const calm = useCalmReading(live, fresh);
  const sensor = !live || live.age_s > 60 ? "offline" : !live.radar_ok ? "no-radar" : fresh ? "live" : "idle";
  const sample = { present: calm.present, distCm: calm.distCm, moving: calm.moving, pc: status?.state ?? "?" };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="wordmark">radarwake</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          <button className={tab === "overview" ? "on" : ""} onClick={() => selectTab("overview")}>
            Overview
          </button>
          <button className={tab === "display" ? "on" : ""} onClick={() => selectTab("display")}>
            Display
          </button>
        </nav>
        <div className="topbar-right">
          <span className={`link ${offline ? "down" : sensor === "live" || sensor === "idle" ? "up" : "warn"}`}>
            {offline ? "No connection" : sensor === "offline" ? "Sensor offline" : "Connected"}
          </span>
          <button className="btn sm ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      {offline && <p className="banner">Server unreachable. Retrying…</p>}

      {tab === "overview" ? (
        <Overview calm={calm} sensor={sensor} presence={presence} status={status} history={history} busy={busy} run={run} />
      ) : (
        <DisplayTab sample={sample} toast={toast} />
      )}

      {toastMsg && (
        <div className={`toast ${toastMsg.error ? "error" : ""}`} role="status">
          {toastMsg.text}
        </div>
      )}
    </main>
  );
}
