import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { IdentityProvider } from './store/identity'
import ErrorBoundary from './components/ErrorBoundary'
import { KeyGenerationProvider } from './components/KeyGeneration'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <KeyGenerationProvider>
        <IdentityProvider>
          <App />
        </IdentityProvider>
        </KeyGenerationProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>,
)
