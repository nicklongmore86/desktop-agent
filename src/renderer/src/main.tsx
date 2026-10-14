import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiContext } from './api'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <ApiContext value={window.desktopApi}>
      <App />
    </ApiContext>
  </StrictMode>,
)
