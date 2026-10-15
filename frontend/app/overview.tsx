"use client";

import { PcStatus, PresenceCurrent, PresenceEvent, api } from "@/lib/api";
import type { CalmReading } from "@/lib/calm";
import { RangeView } from "./range-view";

const PC_LABEL: Record<PcStatus["state"], string> = { on: "Online", off: "Offline", waking: "Booting" };

export function Overview({
  calm,
  sensor,
  presence,
  status,
  history,
  busy,
  run,
}: {
  calm: CalmReading;
  sensor: "live" | "idle" | "offline" | "no-radar";
  presence: PresenceCurrent | null;
  status: PcStatus | null;
  history: PresenceEvent[];
  busy: boolean;
  run: (label: string, fn: () => Promise<unknown>, confirmText?: string) => void;
}) {
  const state = status?.state;
  const down = sensor === "offline" || sensor === "no-radar";
  return (
    <div className="grid">
      <section className="card presence">
        <header className="card-head">
          <h2>Presence</h2>
          <span className={`status ${down ? "warn" : calm.present ? "ok" : ""}`}>
            {down ? "Sensor offline" : calm.present ? "Someone at the desk" : presence?.present ? "Recently seen" : "Room clear"}
          </span>
        </header>
        <RangeView distCm={calm.distCm} moving={calm.moving} state={down ? "offline" : calm.present ? "live" : "idle"} />
        <dl className="stats">
          <div>
            <dt>Motion</dt>
            <dd>{calm.present ? (calm.moving ? "Moving" : "Still") : "–"}</dd>
          </div>
          <div>
            <dt>Signal</dt>
            <dd className="mono">{calm.signal !== null ? `${calm.signal}%` : "–"}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{presence?.last_present_at ? ago(presence.last_present_at) : "–"}</dd>
          </div>
        </dl>
        {down && (
          <p className="note">
            {sensor === "no-radar"
              ? "The ESP32 is online but gets no data from the radar. Check the radar wiring and 5 V."
              : "No reports from the ESP32. Check its power and Wi-Fi."}
          </p>
        )}
      </section>

      <section className="card">
        <header className="card-head">
          <h2>Workstation</h2>
          <span className={`status ${state === "on" ? "ok" : state === "waking" ? "busy" : ""}`}>{state ? PC_LABEL[state] : "…"}</span>
        </header>
        <p className="muted">
          {status?.last_heartbeat_at ? `Agent heartbeat ${ago(status.last_heartbeat_at)}` : "No heartbeat from the agent yet"}
        </p>
        <div className="actions">
          <button className="btn primary" disabled={busy || state !== "off"} onClick={() => run("Wake signal sent", api.wake)}>
            Wake
          </button>
          <button className="btn" disabled={busy || state !== "on"} onClick={() => run("Sleep command sent", () => api.sleep("sleep"))}>
            Sleep
          </button>
          <button
            className="btn danger"
            disabled={busy || state !== "on"}
            onClick={() => run("Shutdown command sent", () => api.sleep("shutdown"), "Shut down the workstation? Unsaved work may be lost.")}
          >
            Shut down
          </button>
        </div>
      </section>

      <section className="card wide">
        <header className="card-head">
          <h2>Activity</h2>
          <span className="muted mono">{occupancy(history)} in the last 24 h</span>
        </header>
        <Timeline events={history} />
      </section>
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
  return `${h}h ${m}m`;
}

function Timeline({ events }: { events: PresenceEvent[] }) {
  const end = Date.now();
  const start = end - 24 * 3600 * 1000;
  const pct = (t: number) => ((t - start) / (end - start)) * 100;
  const hours = [24, 18, 12, 6];
  return (
    <div className="timeline">
      <div className="timeline-bar">
        {[25, 50, 75].map((p) => (
          <i key={p} style={{ left: `${p}%` }} />
        ))}
        {segments(events, start, end).map(([a, b]) => (
          <span key={a} style={{ left: `${pct(a)}%`, width: `${Math.max(pct(b) - pct(a), 0.2)}%` }} />
        ))}
      </div>
      <div className="timeline-ticks mono">
        {hours.map((h) => (
          <span key={h}>{clock(end - h * 3600 * 1000)}</span>
        ))}
        <span>now</span>
      </div>
    </div>
  );
}

function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
