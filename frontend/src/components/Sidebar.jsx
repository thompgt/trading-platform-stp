import { NavLink } from 'react-router-dom'
import { useBackendHealth } from '../api/useBackendHealth.js'

const NAV_SECTIONS = [
  {
    label: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: '▦' }],
  },
  {
    label: 'Trading',
    items: [
      { to: '/orders', label: 'Order Blotter', icon: '☰' },
      { to: '/paper-trading', label: 'Paper Trading', icon: '▷' },
    ],
  },
  {
    label: 'Portfolio & Analytics',
    items: [
      { to: '/portfolio', label: 'Portfolio', icon: '◉' },
      { to: '/analytics', label: 'Technical Analytics', icon: '≈' },
      { to: '/reporting', label: 'Reporting & Charting', icon: '▤' },
    ],
  },
  {
    label: 'Risk & Oversight',
    items: [
      { to: '/risk-compliance', label: 'Risk & Compliance', icon: '⚠' },
      { to: '/agents', label: 'Agent Activity', icon: '⚙' },
    ],
  },
]

const HEALTH_LABEL = {
  checking: 'Checking backend…',
  online: 'Backend online',
  offline: 'Backend offline',
}

export default function Sidebar() {
  const health = useBackendHealth()

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">STP</span>
        <span className="sidebar-brand-text">Trading Platform</span>
      </div>
      <nav>
        {NAV_SECTIONS.map((section) => (
          <div className="sidebar-section" key={section.label}>
            <div className="sidebar-section-label">{section.label}</div>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}
              >
                <span className="sidebar-link-icon">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-health" role="status">
        <span className={`sidebar-health-dot sidebar-health-${health}`} />
        {HEALTH_LABEL[health]}
      </div>
    </aside>
  )
}
