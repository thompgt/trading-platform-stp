const TONE_CLASS = { good: 'bar-pos', bad: 'bar-neg', warn: 'bar-warn', neutral: 'bar-accent' }

/**
 * Generic horizontal magnitude bar list — one bar per labeled item, scaled to the
 * largest |value| in the set. `toneFor` picks good/bad/warn/neutral per row (default:
 * sign of value, i.e. polarity); pass a constant tone for chart where every bar shares
 * one meaning (e.g. gross exposure — magnitude only, no polarity).
 */
export default function BarChart({
  items,
  toneFor,
  formatValue = (v) => v.toFixed(0),
  emptyLabel = 'No data.',
  // Width of the label column. Tickers fit the 80px default; long labels such as route
  // patterns need more room, and would otherwise truncate to an ellipsis.
  labelWidth,
}) {
  if (!items || items.length === 0) {
    return <p className="empty-state">{emptyLabel}</p>
  }

  const max = Math.max(...items.map((i) => Math.abs(i.value)), 0)

  return (
    <div className="bar-chart" style={labelWidth ? { '--bar-label-width': labelWidth } : undefined}>
      {items.map((item) => {
        const pct = max === 0 ? 0 : Math.round((Math.abs(item.value) / max) * 100)
        const tone = toneFor ? toneFor(item) : item.value >= 0 ? 'good' : 'bad'
        const toneClass = TONE_CLASS[tone] || TONE_CLASS.neutral
        return (
          <div className="bar-row" key={item.label}>
            <span className="bar-label mono">{item.label}</span>
            <div className="bar-track">
              <div className={`bar-fill ${toneClass}`} style={{ width: `${pct}%` }} />
            </div>
            <span className={`bar-value ${tone === 'good' ? 'value-pos' : tone === 'bad' ? 'value-neg' : ''}`}>
              {formatValue(item.value)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
