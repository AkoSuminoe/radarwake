// Calm range readout: one number and a 0-4 m rail. The LD2410C measures range only,
// so there is no bearing to draw. The marker eases to a new position instead of jumping.

const MAX_CM = 400;
const TICKS = [0, 1, 2, 3, 4];

export function RangeView({ distCm, moving, state }: { distCm: number | null; moving: boolean; state: "live" | "idle" | "offline" }) {
  const pct = distCm !== null ? Math.min(distCm, MAX_CM) / MAX_CM : null;
  return (
    <div className={`range ${state}`}>
      <div className="range-value">
        <span className="num">{distCm !== null ? (distCm / 100).toFixed(1) : "–"}</span>
        <span className="unit">m</span>
      </div>
      <div className="rail" role="img" aria-label={distCm !== null ? `Target at ${(distCm / 100).toFixed(1)} metres` : "No target"}>
        <div className="rail-track">
          {pct !== null && <div className="rail-fill" style={{ transform: `scaleX(${pct})` }} />}
          {pct !== null && (
            <div className={`rail-marker ${moving ? "moving" : ""}`} style={{ left: `${pct * 100}%` }} />
          )}
        </div>
        <div className="rail-ticks">
          {TICKS.map((m) => (
            <span key={m} style={{ left: `${(m * 100) / 4}%` }}>
              {m} m
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
