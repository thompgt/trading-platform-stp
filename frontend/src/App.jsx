import { Routes, Route, useLocation } from 'react-router-dom'
import Sidebar from './components/Sidebar.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Dashboard from './pages/Dashboard.jsx'
import OrderBlotter from './pages/OrderBlotter.jsx'
import Portfolio from './pages/Portfolio.jsx'
import RiskCompliance from './pages/RiskCompliance.jsx'
import Reporting from './pages/Reporting.jsx'
import Analytics from './pages/Analytics.jsx'
import PaperTrading from './pages/PaperTrading.jsx'
import AgentActivity from './pages/AgentActivity.jsx'
import SystemHealth from './pages/SystemHealth.jsx'

export default function App() {
  const location = useLocation()

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        {/* Keyed by path so a crash on one page doesn't stick around after navigating away */}
        <ErrorBoundary key={location.pathname}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/orders" element={<OrderBlotter />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/risk-compliance" element={<RiskCompliance />} />
            <Route path="/reporting" element={<Reporting />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/paper-trading" element={<PaperTrading />} />
            <Route path="/agents" element={<AgentActivity />} />
            <Route path="/system-health" element={<SystemHealth />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  )
}
