export function Card({ title, subtitle, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || subtitle) && (
        <header className="card-header">
          {title && <h2>{title}</h2>}
          {subtitle && <p className="card-subtitle">{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  )
}

const STATUS_TONES = {
  healthy: 'tone-good',
  warning: 'tone-warn',
  alert: 'tone-bad',
  complete: 'tone-good',
  'in-progress': 'tone-warn',
  planned: 'tone-neutral',
  high: 'tone-bad',
  medium: 'tone-warn',
  low: 'tone-neutral',
  running: 'tone-good',
  paused: 'tone-neutral',
}

export function Badge({ status, children }) {
  const tone = STATUS_TONES[status] || 'tone-neutral'
  return <span className={`badge ${tone}`}>{children ?? status}</span>
}

export function StatTile({ label, value, delta, deltaTone }) {
  return (
    <div className="stat-tile">
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{value}</div>
      {delta && <div className={`stat-tile-delta ${deltaTone || ''}`}>{delta}</div>}
    </div>
  )
}
