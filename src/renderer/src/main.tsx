import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiContext } from './api'
import { App } from './App'
import { ToastProvider } from './components/Toast'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <ApiContext value={window.desktopApi}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ApiContext>
  </StrictMode>,
)
