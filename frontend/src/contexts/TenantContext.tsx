import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { setActiveTenantId } from '../api/client'
import { meApi } from '../api/me'
import type { UserTenantContext } from '../api/me'
import type { AppRole } from '../authConfig'
import { ROLES } from '../authConfig'
import { useAuth } from '../hooks/useAuth'

type TenantContextState = {
  loading: boolean
  loadError: 'session_expired' | 'unavailable' | null
  needsSelection: boolean
  noAccess: boolean
  tenants: UserTenantContext[]
  activeTenant: UserTenantContext | null
  activeRole: UserTenantContext['role'] | null
  selectTenant: (tenantId: string) => void
  refresh: () => Promise<void>
}

const ACTIVE_TENANT_STORAGE_KEY = 'phw_active_tenant_id'
const ROLE_PRIORITY: Record<UserTenantContext['role'], number> = {
  root_admin: 6,
  support: 5,
  admin: 4,
  event_creator: 3,
  tavf_creator: 2,
  member: 1,
}

const MEMBERSHIP_KIND_PRIORITY: Record<UserTenantContext['membership_kind'], number> = {
  home: 3,
  admin: 2,
  temporary_demo: 1,
}

const TenantContext = createContext<TenantContextState | null>(null)

function activeRoleHasAppRole(activeRole: UserTenantContext['role'] | null | undefined, requiredRole: AppRole): boolean {
  if (!activeRole) {
    return false
  }
  if (activeRole === 'root_admin' || activeRole === 'support' || activeRole === 'admin') {
    return true
  }
  if (activeRole === 'event_creator') {
    return requiredRole !== ROLES.ADMIN
  }
  if (activeRole === 'tavf_creator') {
    return requiredRole === ROLES.TAVF_CREATOR || requiredRole === ROLES.USER
  }
  return requiredRole === ROLES.USER
}

function isTenantId(value: string | null | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
}

function normalizeTenantId(value: string | null | undefined): string | null {
  if (!isTenantId(value)) {
    return null
  }
  return value.trim().toLowerCase()
}

function getIdentityStorageKey(identityKey: string): string {
  return `${ACTIVE_TENANT_STORAGE_KEY}:${encodeURIComponent(identityKey)}`
}

function getStoredTenantId(identityKey: string): string | null {
  if (typeof window === 'undefined') {
    return null
  }
  window.localStorage.removeItem(ACTIVE_TENANT_STORAGE_KEY)
  return normalizeTenantId(window.localStorage.getItem(getIdentityStorageKey(identityKey)))
}

function storeTenantId(identityKey: string, tenantId: string): void {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.removeItem(ACTIVE_TENANT_STORAGE_KEY)
  window.localStorage.setItem(getIdentityStorageKey(identityKey), tenantId.trim().toLowerCase())
}

function isTenantSelectionExpired(tenant: UserTenantContext): boolean {
  if (!tenant.expires_at) {
    return false
  }
  const expiresAt = Date.parse(tenant.expires_at)
  return !Number.isNaN(expiresAt) && expiresAt <= Date.now()
}

function pickPreferredTenantContext(current: UserTenantContext, candidate: UserTenantContext): UserTenantContext {
  const currentExpired = isTenantSelectionExpired(current)
  const candidateExpired = isTenantSelectionExpired(candidate)
  if (currentExpired !== candidateExpired) {
    return candidateExpired ? current : candidate
  }

  const currentMembershipScore = MEMBERSHIP_KIND_PRIORITY[current.membership_kind] ?? 0
  const candidateMembershipScore = MEMBERSHIP_KIND_PRIORITY[candidate.membership_kind] ?? 0
  if (currentMembershipScore !== candidateMembershipScore) {
    return candidateMembershipScore > currentMembershipScore ? candidate : current
  }

  const currentRoleScore = ROLE_PRIORITY[current.role] ?? 0
  const candidateRoleScore = ROLE_PRIORITY[candidate.role] ?? 0
  if (currentRoleScore !== candidateRoleScore) {
    return candidateRoleScore > currentRoleScore ? candidate : current
  }

  return current
}

function dedupeTenantContexts(tenants: UserTenantContext[]): UserTenantContext[] {
  const deduped = new Map<string, UserTenantContext>()
  for (const tenant of tenants) {
    const key = tenant.tenant_id.trim().toLowerCase()
    const current = deduped.get(key)
    if (!current) {
      deduped.set(key, tenant)
      continue
    }
    deduped.set(key, pickPreferredTenantContext(current, tenant))
  }

  return [...deduped.values()]
}

function chooseDefaultTenant(tenants: UserTenantContext[], persistedTenantId: string | null): {
  activeTenantId: string | null
  needsSelection: boolean
} {
  const eligibleTenants = tenants.filter((tenant) => !isTenantSelectionExpired(tenant))
  if (eligibleTenants.length === 0) {
    return { activeTenantId: null, needsSelection: false }
  }

  const persistedTenant = persistedTenantId
    ? eligibleTenants.find((tenant) => tenant.tenant_id.toLowerCase() === persistedTenantId)
    : undefined

  if (persistedTenant) {
    return { activeTenantId: persistedTenant.tenant_id, needsSelection: false }
  }

  if (eligibleTenants.length === 1) {
    return { activeTenantId: eligibleTenants[0].tenant_id, needsSelection: false }
  }

  const homeTenant = eligibleTenants.find((tenant) => tenant.membership_kind === 'home')
  return {
    activeTenantId: homeTenant?.tenant_id ?? null,
    needsSelection: true,
  }
}

function TenantProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, rolesReady, user } = useAuth()
  const identityKey = (user?.id || user?.email || '').trim().toLowerCase()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<'session_expired' | 'unavailable' | null>(null)
  const [needsSelection, setNeedsSelection] = useState(false)
  const [tenants, setTenants] = useState<UserTenantContext[]>([])
  const [activeTenantId, setActiveTenantIdState] = useState<string | null>(null)
  const requestGenerationRef = useRef(0)
  const requestAbortRef = useRef<AbortController | null>(null)

  const noAccess = !loading && !loadError && isAuthenticated && rolesReady && tenants.length === 0

  const refresh = async () => {
    if (!isAuthenticated || !rolesReady || !identityKey) {
      return
    }

    const generation = ++requestGenerationRef.current
    requestAbortRef.current?.abort()
    const controller = new AbortController()
    requestAbortRef.current = controller
    setLoading(true)
    setLoadError(null)
    try {
      const response = dedupeTenantContexts(await meApi.listTenants(controller.signal))
      if (generation !== requestGenerationRef.current || controller.signal.aborted) return
      const persistedTenantId = getStoredTenantId(identityKey)
      const { activeTenantId: nextActiveTenantId, needsSelection: shouldSelect } = chooseDefaultTenant(response, persistedTenantId)

      setTenants(response)
      setNeedsSelection(shouldSelect)
      setActiveTenantIdState(nextActiveTenantId)
      setActiveTenantId(nextActiveTenantId)
    } catch (error) {
      if (generation !== requestGenerationRef.current || controller.signal.aborted) return
      console.error('[tenant-context] Failed to load tenants', error)
      const message = error instanceof Error ? error.message : ''
      setLoadError(/\b401\b/.test(message) ? 'session_expired' : 'unavailable')
      setNeedsSelection(false)
    } finally {
      if (generation === requestGenerationRef.current && !controller.signal.aborted) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!isAuthenticated || !rolesReady || !identityKey) {
      requestGenerationRef.current += 1
      requestAbortRef.current?.abort()
      setLoading(false)
      setLoadError(null)
      setNeedsSelection(false)
      setTenants([])
      setActiveTenantIdState(null)
      setActiveTenantId(null)
      return
    }

    void refresh()
    return () => {
      requestGenerationRef.current += 1
      requestAbortRef.current?.abort()
    }
  }, [identityKey, isAuthenticated, rolesReady])

  const selectTenant = (tenantId: string) => {
    const normalized = normalizeTenantId(tenantId)
    if (!normalized) {
      return
    }

    const selected = tenants.find((tenant) => tenant.tenant_id.toLowerCase() === normalized)
    if (!selected || isTenantSelectionExpired(selected)) {
      return
    }

    setActiveTenantIdState(selected.tenant_id)
    setNeedsSelection(false)
    storeTenantId(identityKey, selected.tenant_id)
    setActiveTenantId(selected.tenant_id)
  }

  const activeTenant = useMemo(() => {
    if (!activeTenantId) {
      return null
    }
    return tenants.find((tenant) => tenant.tenant_id.toLowerCase() === activeTenantId.toLowerCase()) ?? null
  }, [activeTenantId, tenants])

  const value = useMemo<TenantContextState>(() => ({
    loading,
    loadError,
    needsSelection,
    noAccess,
    tenants,
    activeTenant,
    activeRole: activeTenant?.role ?? null,
    selectTenant,
    refresh,
  }), [activeTenant, loadError, loading, needsSelection, noAccess, tenants])

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
}

function useTenantContext(): TenantContextState {
  const value = useContext(TenantContext)
  if (!value) {
    throw new Error('useTenantContext must be used inside TenantProvider')
  }
  return value
}

export { TenantProvider, useTenantContext, chooseDefaultTenant, dedupeTenantContexts }
export { activeRoleHasAppRole }
