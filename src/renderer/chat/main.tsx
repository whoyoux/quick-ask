import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { ChatApp } from '../overlay/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChatApp />
  </StrictMode>
)
