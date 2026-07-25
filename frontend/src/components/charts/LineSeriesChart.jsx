import { useMemo, useRef, useState } from 'react'

const WIDTH = 640
const HEIGHT = 220
const PAD = { top: 12, right: 16, bottom: 24, left: 52 }

/**
 * Single-series line chart (price or equity curve) with a hover crosshair + tooltip and
 * optional trade markers. One axis only — never paired with a second, differently-scaled
 * series on a secondary y-axis (see dataviz skill: "one axis" rule).
 */
export default function LineSeriesChart({
  data,
  xKey = 'ts',
  yKey,
  color = 'var(--series-1)',
  formatY = (v) => v.toFixed(2),
  markers = [],
  emptyLabel = 'No data yet.',
  // Draws a dashed baseline (typically 0) and forces the y-domain to include it. Without
  // this, a P&L series that never goes negative would be drawn as though its own minimum
  // were breakeven, which reads as a loss that never happened.
  referenceValue = null,
}) {
  const svgRef = useRef(null)
  const [hoverIndex, setHoverIndex] = useState(null)

  const { points, yMin, yMax, plotW, plotH } = useMemo(() => {
    const plotW = WIDTH - PAD.left - PAD.right
    const plotH = HEIGHT - PAD.top - PAD.bottom
    if (!data || data.length === 0) {
      return { points: [], yMin: 0, yMax: 1, plotW, plotH }
    }
    const values = data.map((d) => d[yKey])
    const yMin = referenceValue == null ? Math.min(...values) : Math.min(...values, referenceValue)
    const yMax = referenceValue == null ? Math.max(...values) : Math.max(...values, referenceValue)
    const range = yMax - yMin || 1
    const points = data.map((d, i) => {
      const x = PAD.left + (data.length === 1 ? 0 : (i / (data.length - 1)) * plotW)
      const y = PAD.top + plotH - ((d[yKey] - yMin) / range) * plotH
      return { x, y, raw: d }
    })
    return { points, yMin, yMax, plotW, plotH }
  }, [data, yKey, referenceValue])

  if (!data || data.length === 0) {
    return <p className="empty-state">{emptyLabel}</p>
  }

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const areaPath = `${path} L ${points[points.length - 1].x.toFixed(1)} ${PAD.top + plotH} L ${points[0].x.toFixed(1)} ${PAD.top + plotH} Z`

  const markerPoints = markers
    .map((m) => {
      const idx = data.findIndex((d) => new Date(d[xKey]).getTime() === new Date(m.ts).getTime())
      return idx === -1 ? null : { ...points[idx], side: m.side }
    })
    .filter(Boolean)

  function handleMove(e) {
    const rect = svgRef.current.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * WIDTH
    let closest = 0
    let closestDist = Infinity
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - x)
      if (dist < closestDist) {
        closestDist = dist
        closest = i
      }
    })
    setHoverIndex(closest)
  }

  const hovered = hoverIndex != null ? points[hoverIndex] : null
  const gridLines = 4

  return (
    <div className="line-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="line-chart-svg"
        role="img"
        aria-label={`${yKey} over time chart`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {Array.from({ length: gridLines + 1 }, (_, i) => {
          const y = PAD.top + (plotH / gridLines) * i
          const value = yMax - ((yMax - yMin) / gridLines) * i
          return (
            <g key={i}>
              <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} className="chart-gridline" />
              <text x={PAD.left - 8} y={y + 3} className="chart-axis-label" textAnchor="end">
                {formatY(value)}
              </text>
            </g>
          )
        })}

        <path d={areaPath} fill={color} opacity="0.08" stroke="none" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {referenceValue != null && (
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={PAD.top + plotH - ((referenceValue - yMin) / (yMax - yMin || 1)) * plotH}
            y2={PAD.top + plotH - ((referenceValue - yMin) / (yMax - yMin || 1)) * plotH}
            className="chart-reference-line"
          />
        )}

        {markerPoints.map((m, i) => (
          <circle
            key={i}
            cx={m.x}
            cy={m.y}
            r="4.5"
            className={m.side === 'BUY' ? 'chart-marker-buy' : 'chart-marker-sell'}
          />
        ))}

        {hovered && (
          <>
            <line x1={hovered.x} x2={hovered.x} y1={PAD.top} y2={PAD.top + plotH} className="chart-crosshair" />
            <circle cx={hovered.x} cy={hovered.y} r="4" fill={color} stroke="var(--bg-panel)" strokeWidth="2" />
          </>
        )}
      </svg>

      {hovered && (
        <div
          className="chart-tooltip"
          style={{ left: `${(hovered.x / WIDTH) * 100}%`, top: `${(hovered.y / HEIGHT) * 100}%` }}
        >
          <div className="chart-tooltip-date">{new Date(hovered.raw[xKey]).toLocaleDateString()}</div>
          <div className="chart-tooltip-value">{formatY(hovered.raw[yKey])}</div>
        </div>
      )}
    </div>
  )
}
