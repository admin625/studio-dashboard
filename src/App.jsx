import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AppProvider } from './context/AppContext'
import ErrorBoundary from './components/ErrorBoundary'
import AuthProvider from './components/AuthProvider'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import BrandSettings from './pages/BrandSettings'
import Photos from './pages/Photos'
import DeliveryView from './pages/DeliveryView'
import ProtectedRoute from './components/ProtectedRoute'
import HelpChatWidget from './components/HelpChatWidget'

function HelpChat() {
  const location = useLocation()
  const page = location.pathname.replace(/^\//, '') || 'deliveries'
  return <HelpChatWidget currentPage={page} />
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <HashRouter>
          <AuthProvider>
            <HelpChat />
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route
                path="/deliveries"
                element={
                  <ProtectedRoute>
                    <Dashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/photos"
                element={
                  <ProtectedRoute>
                    <Photos />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/brand"
                element={
                  <ProtectedRoute>
                    <BrandSettings />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/delivery/:id"
                element={
                  <ProtectedRoute>
                    <DeliveryView />
                  </ProtectedRoute>
                }
              />
              <Route path="/" element={<Navigate to="/deliveries" replace />} />
              <Route path="*" element={<Navigate to="/deliveries" replace />} />
            </Routes>
          </AuthProvider>
        </HashRouter>
      </AppProvider>
    </ErrorBoundary>
  )
}
