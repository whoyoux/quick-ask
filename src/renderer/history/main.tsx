import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { HistoryApp } from './HistoryApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HistoryApp />
  </StrictMode>
)
