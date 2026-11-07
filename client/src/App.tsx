import React from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useIdentity } from './store/identity'
import Landing from './pages/Landing'
import Onboarding from './pages/Onboarding'
import AppPage from './pages/AppPage'

function RequireIdentity({ children }: { children: React.ReactNode }) {
  const { identity, restoring } = useIdentity()
  if (restoring) return <div role="status" className="p-6">Restoring identity…</div>
  return identity ? <>{children}</> : <Navigate to="/" replace />
}

function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { identity, restoring } = useIdentity()
  if (restoring) return <div role="status" className="p-6">Restoring identity…</div>
  return identity ? <Navigate to="/app" replace /> : <>{children}</>
}

export default function App() {
  const navigate = useNavigate()
  const { identity } = useIdentity()

  return (
    <Routes>
      <Route
        path="/"
        element={<Landing />}
      />
      <Route
        path="/onboarding"
        element={
          <RedirectIfAuthed>
            <Onboarding onComplete={() => navigate('/app')} />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/app"
        element={
          <RequireIdentity>
            <AppPage key={`${identity?.fingerprint}:${identity?.registryUrl}`} />
          </RequireIdentity>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
