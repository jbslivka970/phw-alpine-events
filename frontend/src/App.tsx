import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { ROLES } from './authConfig'
import Layout from './components/Layout'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AdminPage } from './pages/AdminPage'
import { CalendarPage } from './pages/CalendarPage'
import { GroupsPage } from './pages/GroupsPage'
import DashboardPage from './pages/DashboardPage'
import { EventsPage } from './pages/EventsPage'
import { EventAssignmentPage } from './pages/EventAssignmentPage'
import { LoginPage } from './pages/LoginPage'
import { ImportPage } from './pages/ImportPage'
import { MembersPage } from './pages/MembersPage'
import { NotificationPreferencesPage } from './pages/NotificationPreferencesPage'
import { PrivacyPolicyPage } from './pages/PrivacyPolicyPage'
import { PublicRsvpPage } from './pages/PublicRsvpPage'
import { ReportsPage } from './pages/ReportsPage'
import { SmsProgramPage } from './pages/SmsProgramPage'
import { TavfListPage } from './pages/TavfListPage'
import { TavfNewPage } from './pages/TavfNewPage'
import { TavfDetailPage } from './pages/TavfDetailPage'
import { TermsPage } from './pages/TermsPage'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/privacy" element={<PrivacyPolicyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/sms-program" element={<SmsProgramPage />} />
        <Route path="/rsvp/:token" element={<PublicRsvpPage />} />

        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/preferences" element={<NotificationPreferencesPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route
            path="/events/:id/assign"
            element={
              <ProtectedRoute requiredRole={ROLES.ADMIN}>
                <EventAssignmentPage />
              </ProtectedRoute>
            }
          />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/tavf" element={<TavfListPage />} />
          <Route
            path="/tavf/new"
            element={
              <ProtectedRoute requiredRole={ROLES.EVENT_CREATOR}>
                <TavfNewPage />
              </ProtectedRoute>
            }
          />
          <Route path="/tavf/:id" element={<TavfDetailPage />} />
          <Route
            path="/groups"
            element={
              <ProtectedRoute requiredRole={ROLES.ADMIN}>
                <GroupsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/members"
            element={
              <ProtectedRoute requiredRole={ROLES.ADMIN}>
                <MembersPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/import"
            element={
              <ProtectedRoute requiredRole={ROLES.ADMIN}>
                <ImportPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedRoute requiredRole={ROLES.ADMIN}>
                <ReportsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute requiredRole={ROLES.ADMIN}>
                <AdminPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>

        <Route path="/" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}


export default App