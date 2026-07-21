const TONE_CLASS = { good: 'bar-pos', bad: 'bar-neg', warn: 'bar-warn', neutral: 'bar-accent' }

/** Compact inline magnitude meter (no label) for table cells — a bar-track/bar-fill pair sized to `pct` (0-100). */
export default function Meter({ pct, tone = 'neutral', label }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="meter" role="img" aria-label={label ?? `${Math.round(clamped)}%`}>
      <div className="bar-track meter-track">
        <div className={`bar-fill ${TONE_CLASS[tone] || TONE_CLASS.neutral}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="meter-value">{Math.round(clamped)}%</span>
    </div>
  )
}
