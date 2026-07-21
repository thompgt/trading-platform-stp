const CATEGORICAL = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)']

/**
 * Categorical donut, capped at 3 slots — the dataviz palette's first three categorical
 * hues are the ones validated for all-pairs comparison (the situation a pie/donut puts
 * every slice into at once). A 4th+ category should fold into "Other" rather than adding
 * a 4th hue here.
 */
export default function DonutChart({ data, valueKey = 'value', labelKey = 'label' }) {
  if (!data || data.length === 0) {
    return <p className="empty-state">No allocation data.</p>
  }
  if (data.length > 3) {
    // eslint-disable-next-line no-console
    console.warn('DonutChart: more than 3 categories passed; fold extras into "Other" before rendering.')
  }

  const total = data.reduce((sum, d) => sum + d[valueKey], 0)
  const radius = 60
  const stroke = 26
  const circumference = 2 * Math.PI * radius
  let offset = 0

  const segments = data.slice(0, 3).map((d, i) => {
    const fraction = total === 0 ? 0 : d[valueKey] / total
    const dash = fraction * circumference
    const segment = {
      color: CATEGORICAL[i],
      dashArray: `${dash} ${circumference - dash}`,
      dashOffset: -offset,
      label: d[labelKey],
      value: d[valueKey],
      fraction,
    }
    offset += dash
    return segment
  })

  return (
    <div className="donut-chart">
      <svg viewBox="0 0 160 160" width="140" height="140" role="img" aria-label="Allocation by asset class">
        <circle cx="80" cy="80" r={radius} fill="none" stroke="var(--neutral-bg)" strokeWidth={stroke} />
        {segments.map((s, i) => (
          <circle
            key={i}
            cx="80"
            cy="80"
            r={radius}
            fill="none"
            stroke={s.color}
            strokeWidth={stroke}
            strokeDasharray={s.dashArray}
            strokeDashoffset={s.dashOffset}
            transform="rotate(-90 80 80)"
          />
        ))}
      </svg>
      <ul className="donut-legend">
        {segments.map((s, i) => (
          <li key={i}>
            <span className="donut-legend-swatch" style={{ background: s.color }} />
            <span className="donut-legend-label">{s.label}</span>
            <span className="donut-legend-value">{Math.round(s.fraction * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
