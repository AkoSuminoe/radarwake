"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, LiveReading, PcStatus, PresenceCurrent, PresenceEvent, api, errorText } from "@/lib/api";
import { Echo, Sonar } from "./sonar";

type Auth = "loading" | "out" | "in";

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
      <form className="panel login" onSubmit={submit}>
        <div className="login-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1 className="wordmark">radarwake</h1>
        <p className="eyebrow center">Restricted · Local network only</p>
        <label>
          <span className="eyebrow">Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          <span className="eyebrow">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>
          {busy ? "Authenticating…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

const PC_LABEL: Record<PcStatus["state"], string> = { on: "Online", off: "Offline", waking: "Booting" };

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [status, setStatus] = useState<PcStatus | null>(null);
  const [presence, setPresence] = useState<PresenceCurrent | null>(null);
  const [live, setLive] = useState<LiveReading | null>(null);
  const [echoes, setEchoes] = useState<Echo[]>([]);
  const [history, setHistory] = useState<PresenceEvent[]>([]);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const lastLiveTs = useRef<string | null>(null);

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
      const l = await api.live();
      setLive(l);
      setOffline(false);
      if (l && l.ts !== lastLiveTs.current && l.presence) {
        lastLiveTs.current = l.ts;
        const dist = l.moving ? l.moving_dist : l.stationary_dist;
        if (dist > 0) setEchoes((prev) => [...prev.slice(-40), { t: Date.now(), dist, moving: l.moving }]);
      }
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
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function run(label: string, fn: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await fn();
      setToast({ text: label, error: false });
      await refreshStatus();
    } catch (err) {
      setToast({ text: errorText(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api.logout().catch(() => {});
    onLogout();
  }

  const fresh = !!live && live.age_s < LIVE_STALE_S;
  const sensorDown = !live || live.age_s > 60 || !live.radar_ok;
  const contact = fresh && live.presence;
  const sonarStatus = sensorDown ? "offline" : contact ? "live" : "idle";
  const movingDist = contact && live.moving && live.moving_dist > 0 ? live.moving_dist : null;
  const stillDist = contact && live.stationary && live.stationary_dist > 0 ? live.stationary_dist : null;
  const range = movingDist ?? stillDist;
  const energy = contact ? Math.max(live.moving ? live.moving_energy : 0, live.stationary ? live.stationary_energy : 0) : 0;
  const state = status?.state;

  return (
    <main className="shell">
      <header className="top">
        <span className="wordmark">radarwake</span>
        <div className="top-right">
          <span className={`link-dot ${offline ? "down" : fresh ? "up" : "idle"}`} />
          <span className="eyebrow">{offline ? "No link" : fresh ? "Live" : "Standby"}</span>
          <button className="ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      {offline && <p className="banner">Server unreachable. Retrying…</p>}

      <section className="panel scope">
        <div className="panel-head">
          <span className="eyebrow">Presence scan</span>
          <span className={`chip ${sensorDown ? "warn" : contact ? "on" : "off"}`}>
            {sensorDown ? "Sensor offline" : contact ? "Contact" : presence?.present ? "Recently seen" : "Clear"}
          </span>
        </div>
        <Sonar movingDist={movingDist} stationaryDist={stillDist} echoes={echoes} status={sonarStatus} />
        <div className="readouts">
          <Readout label="Range" value={range !== null ? (range / 100).toFixed(2) : "—"} unit={range !== null ? "m" : ""} />
          <Readout label="Motion" value={!contact ? "—" : live.moving ? "Moving" : "Still"} />
          <div className="readout">
            <span className="eyebrow">Signal</span>
            <span className="value mono">
              {contact ? energy : "—"}
              {contact && <small>%</small>}
            </span>
            <span className="meter">
              <span style={{ width: `${energy}%` }} />
            </span>
          </div>
        </div>
        <p className="footnote">
          {sensorDown
            ? live && !live.radar_ok
              ? "The ESP32 is online but receives no data from the radar. Check its wiring."
              : "No reports from the ESP32. Check its power and Wi-Fi."
            : presence?.last_present_at
              ? `Last contact ${ago(presence.last_present_at)}`
              : "Waiting for first contact"}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">Workstation</span>
          <span className={`chip ${state ?? "off"}`}>{state ? PC_LABEL[state] : "…"}</span>
        </div>
        <p className="footnote">
          {status?.last_heartbeat_at ? `Heartbeat ${ago(status.last_heartbeat_at)}` : "No heartbeat from the agent yet"}
        </p>
        <div className="actions">
          <button
            className="btn primary"
            disabled={busy || state !== "off"}
            onClick={() => run("Wake signal sent", api.wake)}
          >
            Wake
          </button>
          <button
            className="btn"
            disabled={busy || state !== "on"}
            onClick={() => run("Sleep command sent", () => api.sleep("sleep"))}
          >
            Sleep
          </button>
          <button
            className="btn danger"
            disabled={busy || state !== "on"}
            onClick={() =>
              run("Shutdown command sent", () => api.sleep("shutdown"), "Shut down the workstation? Unsaved work may be lost.")
            }
          >
            Shut down
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">Activity · 24h</span>
          <span className="eyebrow dim">{occupancy(history)}</span>
        </div>
        <Timeline events={history} />
      </section>

      {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}
    </main>
  );
}

function Readout({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="readout">
      <span className="eyebrow">{label}</span>
      <span className="value mono">
        {value}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

const MAX_GAP = 2 * 60 * 1000;

// Intervals with presence in the last 24 h. A gap longer than 2 minutes between
// reports (sensor off) counts as empty.
function segments(events: PresenceEvent[], start: number, end: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < events.length; i++) {
    if (!events[i].presence) continue;
    const a = Math.max(Date.parse(events[i].ts), start);
    const next = i + 1 < events.length ? Date.parse(events[i + 1].ts) : end;
    const b = Math.min(next, a + MAX_GAP, end);
    const last = out[out.length - 1];
    if (last && a - last[1] < 1000) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

function occupancy(events: PresenceEvent[]): string {
  const end = Date.now();
  const ms = segments(events, end - 86400000, end).reduce((sum, [a, b]) => sum + (b - a), 0);
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return `${h}h ${m}m occupied`;
}

function Timeline({ events }: { events: PresenceEvent[] }) {
  const end = Date.now();
  const start = end - 24 * 3600 * 1000;
  const pct = (t: number) => ((t - start) / (end - start)) * 100;

  return (
    <div className="timeline">
      <div className="bar">
        {segments(events, start, end).map(([a, b]) => (
          <span key={a} style={{ left: `${pct(a)}%`, width: `${Math.max(pct(b) - pct(a), 0.15)}%` }} />
        ))}
        {[25, 50, 75].map((p) => (
          <i key={p} style={{ left: `${p}%` }} />
        ))}
      </div>
      <div className="ticks mono">
        <span>-24h</span>
        <span>-18h</span>
        <span>-12h</span>
        <span>-6h</span>
        <span>now</span>
      </div>
    </div>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
