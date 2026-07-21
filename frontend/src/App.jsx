import { Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar.jsx'
import Dashboard from './pages/Dashboard.jsx'
import OrderBlotter from './pages/OrderBlotter.jsx'
import Portfolio from './pages/Portfolio.jsx'
import RiskCompliance from './pages/RiskCompliance.jsx'
import Reporting from './pages/Reporting.jsx'
import Analytics from './pages/Analytics.jsx'
import PaperTrading from './pages/PaperTrading.jsx'
import AgentActivity from './pages/AgentActivity.jsx'

export default function App() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/orders" element={<OrderBlotter />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/risk-compliance" element={<RiskCompliance />} />
          <Route path="/reporting" element={<Reporting />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/paper-trading" element={<PaperTrading />} />
          <Route path="/agents" element={<AgentActivity />} />
        </Routes>
      </main>
    </div>
  )
}
