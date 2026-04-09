import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AppProvider } from './context/AppContext'
import Scaffold from './pages/Scaffold'

export default function App() {
  return (
    <AppProvider>
      <HashRouter>
        <Routes>
          <Route path="/*" element={<Scaffold />} />
        </Routes>
      </HashRouter>
    </AppProvider>
  )
}
