import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { IdentityProvider } from './store/identity'
import ErrorBoundary from './components/ErrorBoundary'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <IdentityProvider>
          <App />
        </IdentityProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>,
)
