import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { AppProvider } from './context/AppContext'
import ErrorBoundary from './components/ErrorBoundary'
import AuthProvider from './components/AuthProvider'
import Login from './pages/Login'
import AuthCallback from './pages/AuthCallback'
import ForgotPassword from './pages/ForgotPassword'
import Dashboard from './pages/Dashboard'
import BrandSettings from './pages/BrandSettings'
import Photos from './pages/Photos'
import DeliveryView from './pages/DeliveryView'
import Reels from './pages/Reels'
import ReelUpload from './pages/ReelUpload'
import AccountSettings from './pages/AccountSettings'
import ProtectedRoute from './components/ProtectedRoute'
import HelpChatWidget from './components/HelpChatWidget'

function HelpChat() {
  const location = useLocation()
  const page = location.pathname.replace(/^\//, '') || 'deliveries'
  return <HelpChatWidget currentPage={page} />
}

// 2c — key by :id so DeliveryView fully remounts per delivery. React Router v6
// reuses the component instance across param changes, which otherwise bleeds
// prior delivery state (and any latched error) into the next one.
function DeliveryRoute() {
  const { id } = useParams()
  return <DeliveryView key={id} />
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <BrowserRouter>
          <AuthProvider>
            <HelpChat />
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
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
                path="/reels"
                element={
                  <ProtectedRoute>
                    <Reels />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/reels/upload"
                element={
                  <ProtectedRoute>
                    <ReelUpload />
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
                    <DeliveryRoute />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/settings/account"
                element={
                  <ProtectedRoute>
                    <AccountSettings />
                  </ProtectedRoute>
                }
              />
              <Route path="/" element={<Navigate to="/deliveries" replace />} />
              <Route path="*" element={<Navigate to="/deliveries" replace />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </AppProvider>
    </ErrorBoundary>
  )
}
