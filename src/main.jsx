console.log('[FCA] React app mounting — main.jsx executing')

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

console.log('[FCA] Imports loaded, creating root')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)

console.log('[FCA] Root rendered')
