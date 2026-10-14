"use client";

// Sonar-style view of the LD2410C readings.
// The sensor measures range only (no bearing), so a target is drawn as an arc at the
// measured distance spanning the field of view, not as a made-up point. Older readings
// fade out as an echo trail.

export interface Echo {
  t: number; // ms timestamp
  dist: number; // cm
  moving: boolean;
}

interface Props {
  movingDist: number | null; // cm, null = no moving target
  stationaryDist: number | null; // cm, null = no stationary target
  echoes: Echo[];
  status: "live" | "idle" | "offline";
}

const W = 400;
const H = 236;
const CX = W / 2;
const CY = H - 14;
const R = 200; // px for MAX_CM
const MAX_CM = 400;
const HALF_FOV = 60; // degrees either side of boresight
const RINGS = [100, 200, 300, 400];
const TRAIL_MS = 20000;

function polar(cm: number, deg: number): [number, number] {
  const r = (Math.min(cm, MAX_CM) / MAX_CM) * R;
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function arcPath(cm: number, from = -HALF_FOV, to = HALF_FOV): string {
  const r = (Math.min(cm, MAX_CM) / MAX_CM) * R;
  const [x1, y1] = polar(cm, from);
  const [x2, y2] = polar(cm, to);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function sectorPath(): string {
  const [x1, y1] = polar(MAX_CM, -HALF_FOV);
  const [x2, y2] = polar(MAX_CM, HALF_FOV);
  return `M ${CX} ${CY} L ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2} Z`;
}

export function Sonar({ movingDist, stationaryDist, echoes, status }: Props) {
  const now = Date.now();
  const trail = echoes.filter((e) => now - e.t < TRAIL_MS);

  return (
    <svg className={`sonar ${status}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Radar range display">
      <defs>
        <radialGradient id="sonar-fill" cx={CX} cy={CY} r={R} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.10" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.015" />
        </radialGradient>
        <linearGradient id="sweep-fill" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.28" />
        </linearGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <clipPath id="sector-clip">
          <path d={sectorPath()} />
        </clipPath>
      </defs>

      <path d={sectorPath()} fill="url(#sonar-fill)" stroke="var(--grid-strong)" strokeWidth="1" />

      {RINGS.map((cm) => {
        const [lx, ly] = polar(cm, HALF_FOV);
        return (
          <g key={cm}>
            <path d={arcPath(cm)} fill="none" stroke="var(--grid)" strokeWidth="1" strokeDasharray="2 4" />
            <text x={lx + 6} y={ly + 3} className="sonar-label">
              {cm / 100}m
            </text>
          </g>
        );
      })}

      {[-60, -30, 0, 30, 60].map((deg) => {
        const [x, y] = polar(MAX_CM, deg);
        return <line key={deg} x1={CX} y1={CY} x2={x} y2={y} stroke="var(--grid)" strokeWidth="1" />;
      })}

      <g clipPath="url(#sector-clip)">
        {status !== "offline" && (
          <g className="sweep">
            <path
              d={`M ${CX} ${CY} L ${polar(MAX_CM, -14)[0]} ${polar(MAX_CM, -14)[1]} A ${R} ${R} 0 0 1 ${CX} ${CY - R} Z`}
              fill="url(#sweep-fill)"
            />
            <line x1={CX} y1={CY} x2={CX} y2={CY - R} stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="1.2" />
          </g>
        )}

        {trail.map((e) => {
          const age = (now - e.t) / TRAIL_MS;
          return (
            <path
              key={e.t}
              d={arcPath(e.dist, -HALF_FOV + 4, HALF_FOV - 4)}
              fill="none"
              stroke={e.moving ? "var(--hot)" : "var(--accent)"}
              strokeOpacity={Math.max(0, 0.35 * (1 - age))}
              strokeWidth="1.5"
            />
          );
        })}

        {stationaryDist !== null && (
          <path
            d={arcPath(stationaryDist, -HALF_FOV + 2, HALF_FOV - 2)}
            className="target still"
            filter="url(#glow)"
          />
        )}
        {movingDist !== null && (
          <path d={arcPath(movingDist, -HALF_FOV + 2, HALF_FOV - 2)} className="target moving" filter="url(#glow)" />
        )}
      </g>

      <circle cx={CX} cy={CY} r="3.5" fill="var(--accent)" filter="url(#glow)" />
      <text x={CX} y={H - 1} textAnchor="middle" className="sonar-label dim">
        LD2410C · 24 GHz
      </text>

      {status !== "live" && (
        <text x={CX} y={CY - R * 0.45} textAnchor="middle" className={`sonar-status ${status}`}>
          {status === "offline" ? "SENSOR OFFLINE" : "NO CONTACT"}
        </text>
      )}
    </svg>
  );
}
