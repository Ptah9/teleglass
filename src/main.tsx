import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { setLang } from './i18n'
import { loadSettings } from './store/settings'
import './index.css'

// The stored language must be in force before the first paint, otherwise a
// Russian screen would flash English while an effect runs after it.
setLang(loadSettings().lang)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
