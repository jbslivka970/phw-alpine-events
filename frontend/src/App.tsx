import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { ROLES } from './authConfig'
import Layout from './components/Layout'
import LoadingSkeleton from './components/LoadingSkeleton'
import { ProtectedRoute } from './components/ProtectedRoute'

const AdminPage = lazy(() => import('./pages/AdminPage').then((module) => ({ default: module.AdminPage })))
const AboutPage = lazy(() => import('./pages/AboutPage').then((module) => ({ default: module.AboutPage })))
const CalendarPage = lazy(() => import('./pages/CalendarPage').then((module) => ({ default: module.CalendarPage })))
const GroupsPage = lazy(() => import('./pages/GroupsPage').then((module) => ({ default: module.GroupsPage })))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const EventsPage = lazy(() => import('./pages/EventsPage').then((module) => ({ default: module.EventsPage })))
const EventAssignmentPage = lazy(() => import('./pages/EventAssignmentPage').then((module) => ({ default: module.EventAssignmentPage })))
const FirstTimeOnboardingPage = lazy(() => import('./pages/FirstTimeOnboardingPage').then((module) => ({ default: module.FirstTimeOnboardingPage })))
const LoginPage = lazy(() => import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })))
const ImportPage = lazy(() => import('./pages/ImportPage').then((module) => ({ default: module.ImportPage })))
const MembersPage = lazy(() => import('./pages/MembersPage').then((module) => ({ default: module.MembersPage })))
const NotificationPreferencesPage = lazy(() => import('./pages/NotificationPreferencesPage').then((module) => ({ default: module.NotificationPreferencesPage })))
const PrivacyPolicyPage = lazy(() => import('./pages/PrivacyPolicyPage').then((module) => ({ default: module.PrivacyPolicyPage })))
const PublicRsvpPage = lazy(() => import('./pages/PublicRsvpPage').then((module) => ({ default: module.PublicRsvpPage })))
const ReportsPage = lazy(() => import('./pages/ReportsPage').then((module) => ({ default: module.ReportsPage })))
const SmsProgramPage = lazy(() => import('./pages/SmsProgramPage').then((module) => ({ default: module.SmsProgramPage })))
const TavfListPage = lazy(() => import('./pages/TavfListPage').then((module) => ({ default: module.TavfListPage })))
const TavfNewPage = lazy(() => import('./pages/TavfNewPage').then((module) => ({ default: module.TavfNewPage })))
const TavfDetailPage = lazy(() => import('./pages/TavfDetailPage').then((module) => ({ default: module.TavfDetailPage })))
const TermsPage = lazy(() => import('./pages/TermsPage').then((module) => ({ default: module.TermsPage })))
const TemplatesPage = lazy(() => import('./pages/TemplatesPage').then((module) => ({ default: module.TemplatesPage })))

function RouteFallback() {
  return (
    <div className="page" style={{ padding: '1rem 0' }}>
      <LoadingSkeleton lines={4} />
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/welcome" element={<FirstTimeOnboardingPage />} />
          <Route path="/about" element={<AboutPage />} />
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
                <ProtectedRoute requiredRoles={[ROLES.TAVF_CREATOR, ROLES.USER, ROLES.EVENT_CREATOR]}>
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
              path="/templates"
              element={
                <ProtectedRoute requiredRole={ROLES.ADMIN}>
                  <TemplatesPage />
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
      </Suspense>
    </BrowserRouter>
  )
}


export default App