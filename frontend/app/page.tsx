"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, PcStatus, PresenceCurrent, PresenceEvent, api, errorText } from "@/lib/api";

type Auth = "loading" | "out" | "in";

const POLL_MS = 5000;
const HISTORY_POLL_MS = 60000;

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
    <main className="shell">
      <form className="card login" onSubmit={submit}>
        <h1>radarwake</h1>
        <label>
          Kullanıcı adı
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Şifre
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
          {busy ? "Giriş yapılıyor…" : "Giriş yap"}
        </button>
      </form>
    </main>
  );
}

const STATE_LABEL: Record<PcStatus["state"], string> = { on: "Açık", off: "Kapalı / uykuda", waking: "Açılıyor…" };

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [status, setStatus] = useState<PcStatus | null>(null);
  const [presence, setPresence] = useState<PresenceCurrent | null>(null);
  const [history, setHistory] = useState<PresenceEvent[]>([]);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.status(), api.presence()]);
      setStatus(s);
      setPresence(p);
      setOffline(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogout();
      else setOffline(true);
    }
  }, [onLogout]);

  const refreshHistory = useCallback(() => {
    api.history(24).then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    refreshHistory();
    const a = setInterval(refresh, POLL_MS);
    const b = setInterval(refreshHistory, HISTORY_POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(a);
      clearInterval(b);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, refreshHistory]);

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
      await refresh();
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

  const state = status?.state;

  return (
    <main className="shell">
      <header className="top">
        <h1>radarwake</h1>
        <button className="link" onClick={logout}>
          Çıkış
        </button>
      </header>

      {offline && <p className="banner">Sunucuya ulaşılamıyor, tekrar deneniyor…</p>}

      <section className="card">
        <div className="row">
          <span className="label">Masaüstü PC</span>
          <span className={`pill ${state ?? "unknown"}`}>{state ? STATE_LABEL[state] : "…"}</span>
        </div>
        <p className="muted">
          {status?.last_heartbeat_at ? `Son sinyal: ${ago(status.last_heartbeat_at)}` : "PC ajanından henüz sinyal yok"}
        </p>

        <div className="actions">
          <button
            className="btn primary"
            disabled={busy || state !== "off"}
            onClick={() => run("Uyandırma komutu gönderildi", api.wake)}
          >
            Uyandır
          </button>
          <button
            className="btn"
            disabled={busy || state !== "on"}
            onClick={() => run("Uyku komutu gönderildi", () => api.sleep("sleep"))}
          >
            Uyut
          </button>
          <button
            className="btn danger"
            disabled={busy || state !== "on"}
            onClick={() =>
              run("Kapatma komutu gönderildi", () => api.sleep("shutdown"), "PC kapatılsın mı? Açık işler kaybolabilir.")
            }
          >
            Kapat
          </button>
        </div>
      </section>

      <section className="card">
        <div className="row">
          <span className="label">Oda</span>
          <span className={`pill ${presence?.present ? "on" : "off"}`}>
            {presence ? (presence.present ? "Biri var" : "Boş") : "…"}
          </span>
        </div>
        <p className="muted">
          {!presence
            ? ""
            : !presence.sensor_online
              ? "Radar çevrimdışı"
              : presence.raw_presence
                ? `Algılanan mesafe: ${Math.max(presence.moving_dist ?? 0, presence.stationary_dist ?? 0)} cm`
                : presence.last_present_at
                  ? `Son görülme: ${ago(presence.last_present_at)}`
                  : "Henüz kimse algılanmadı"}
        </p>
        <Timeline events={history} />
      </section>

      {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}
    </main>
  );
}

// Son 24 saatte varlik algilanan araliklar. Iki rapor arasi 2 dakikadan uzunsa
// (sensor kapali) o aralik bos sayilir.
function Timeline({ events }: { events: PresenceEvent[] }) {
  const end = Date.now();
  const start = end - 24 * 3600 * 1000;
  const MAX_GAP = 2 * 60 * 1000;
  const segments: [number, number][] = [];

  for (let i = 0; i < events.length; i++) {
    if (!events[i].presence) continue;
    const a = Date.parse(events[i].ts);
    const next = i + 1 < events.length ? Date.parse(events[i + 1].ts) : end;
    const b = Math.min(next, a + MAX_GAP);
    const last = segments[segments.length - 1];
    if (last && a - last[1] < 1000) last[1] = b;
    else segments.push([a, b]);
  }

  const pct = (t: number) => `${(((t - start) / (end - start)) * 100).toFixed(3)}%`;

  return (
    <div className="timeline">
      <div className="bar">
        {segments.map(([a, b]) => (
          <span key={a} style={{ left: pct(Math.max(a, start)), width: `calc(${pct(b)} - ${pct(Math.max(a, start))})` }} />
        ))}
      </div>
      <div className="ticks">
        <span>24 sa önce</span>
        <span>12 sa</span>
        <span>şimdi</span>
      </div>
    </div>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} sn önce`;
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return `${Math.floor(s / 86400)} gün önce`;
}
