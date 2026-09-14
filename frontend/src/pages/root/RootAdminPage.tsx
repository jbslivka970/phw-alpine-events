import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { rootApi } from '../../api/root'
import { useTenantContext } from '../../contexts/TenantContext'
import type {
  RootDemoMembershipSummary,
  RootTenantAdminSummary,
  RootTenantBranding,
  RootTenantMembershipSummary,
  RootTenantMessaging,
  RootTenantSummary,
  RootTenantUsageSummary,
  TenantBrandingAssetKind,
} from '../../api/root'
import { toUserErrorMessage } from '../../utils/errorMessage'

type TenantCreateForm = {
  slug: string
  display_name: string
  initial_admin_email: string
  initial_admin_display_name: string
  tenant_type: 'program' | 'demo' | 'system'
  status: 'active' | 'suspended' | 'archived'
  timezone: string
}

function RootAdminPage() {
  const navigate = useNavigate()
  const { selectTenant } = useTenantContext()
  const frontendProdHost = 'https://phwalpineeventsfe873a.azurewebsites.net'
  const backendProdHost = 'https://phwalpineeventsjb873a.azurewebsites.net'
  const backendStagingHost = 'https://phwalpineeventsjb873a-staging.azurewebsites.net'
  const frontendStagingHost: string | null = 'https://phwalpineeventsfe873a-staging.azurewebsites.net'

  const [sessionReady, setSessionReady] = useState(false)
  const [isRoot, setIsRoot] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)

  const [tenants, setTenants] = useState<RootTenantSummary[]>([])
  const [tenantLoadBusy, setTenantLoadBusy] = useState(false)
  const [tenantLoadError, setTenantLoadError] = useState<string | null>(null)
  const [tenantPage, setTenantPage] = useState(1)
  const [tenantHasMore, setTenantHasMore] = useState(false)

  const [createForm, setCreateForm] = useState<TenantCreateForm>({
    slug: '',
    display_name: '',
    initial_admin_email: '',
    initial_admin_display_name: '',
    tenant_type: 'program',
    status: 'suspended',
    timezone: 'America/Denver',
  })
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createSuccess, setCreateSuccess] = useState<string | null>(null)

  const [selectedTenantId, setSelectedTenantId] = useState('')
  const [branding, setBranding] = useState<RootTenantBranding | null>(null)
  const [brandingBusy, setBrandingBusy] = useState(false)
  const [brandingSaveBusy, setBrandingSaveBusy] = useState(false)
  const [brandingError, setBrandingError] = useState<string | null>(null)
  const [brandingSuccess, setBrandingSuccess] = useState<string | null>(null)

  const [tenantAdmins, setTenantAdmins] = useState<RootTenantAdminSummary[]>([])
  const [adminLoadBusy, setAdminLoadBusy] = useState(false)
  const [adminGrantBusy, setAdminGrantBusy] = useState(false)
  const [adminGrantError, setAdminGrantError] = useState<string | null>(null)
  const [adminGrantSuccess, setAdminGrantSuccess] = useState<string | null>(null)
  const [adminRevokeBusyUserId, setAdminRevokeBusyUserId] = useState<string | null>(null)
  const [adminEmail, setAdminEmail] = useState('')
  const [adminDisplayName, setAdminDisplayName] = useState('')
  const [adminExpiresAt, setAdminExpiresAt] = useState('')

  const [tenantMemberships, setTenantMemberships] = useState<RootTenantMembershipSummary[]>([])
  const [membershipLoadBusy, setMembershipLoadBusy] = useState(false)
  const [membershipBusy, setMembershipBusy] = useState(false)
  const [membershipError, setMembershipError] = useState<string | null>(null)
  const [membershipSuccess, setMembershipSuccess] = useState<string | null>(null)
  const [membershipPage, setMembershipPage] = useState(1)
  const [membershipHasMore, setMembershipHasMore] = useState(false)
  const [membershipEmail, setMembershipEmail] = useState('')
  const [membershipDisplayName, setMembershipDisplayName] = useState('')
  const [membershipRole, setMembershipRole] = useState('member')
  const [membershipKind, setMembershipKind] = useState('home')
  const [membershipExpiresAt, setMembershipExpiresAt] = useState('')

  const [tenantStatusBusy, setTenantStatusBusy] = useState(false)
  const [tenantStatusMessage, setTenantStatusMessage] = useState<string | null>(null)

  const [usage, setUsage] = useState<RootTenantUsageSummary | null>(null)
  const [usageBusy, setUsageBusy] = useState(false)
  const [usageError, setUsageError] = useState<string | null>(null)

  const [messaging, setMessaging] = useState<RootTenantMessaging | null>(null)
  const [messagingBusy, setMessagingBusy] = useState(false)
  const [messagingSaveBusy, setMessagingSaveBusy] = useState(false)
  const [messagingError, setMessagingError] = useState<string | null>(null)
  const [messagingSuccess, setMessagingSuccess] = useState<string | null>(null)

  const [demoMemberships, setDemoMemberships] = useState<RootDemoMembershipSummary[]>([])
  const [demoLoadBusy, setDemoLoadBusy] = useState(false)
  const [demoGrantBusy, setDemoGrantBusy] = useState(false)
  const [demoResetBusy, setDemoResetBusy] = useState(false)
  const [demoError, setDemoError] = useState<string | null>(null)
  const [demoSuccess, setDemoSuccess] = useState<string | null>(null)
  const [demoEmail, setDemoEmail] = useState('')
  const [demoDisplayName, setDemoDisplayName] = useState('')
  const [demoExpiresAt, setDemoExpiresAt] = useState('')
  const detailGenerationRef = useRef(0)
  const detailAbortRef = useRef<AbortController | null>(null)
  const tenantWriteRef = useRef(false)
  const selectedTenantIdRef = useRef(selectedTenantId)
  selectedTenantIdRef.current = selectedTenantId

  const tenantWriteBusy = brandingSaveBusy
    || adminGrantBusy
    || adminRevokeBusyUserId !== null
    || membershipBusy
    || messagingSaveBusy
    || demoGrantBusy
    || demoResetBusy
    || tenantStatusBusy
  const writeBusy = createBusy || tenantWriteBusy

  function beginTenantWrite(): string | null {
    const tenantId = selectedTenantIdRef.current
    if (!tenantId || tenantWriteRef.current) return null
    tenantWriteRef.current = true
    return tenantId
  }

  function finishTenantWrite(): void {
    tenantWriteRef.current = false
  }

  function isCurrentTenant(tenantId: string): boolean {
    return selectedTenantIdRef.current === tenantId
  }

  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.tenant_id === selectedTenantId) ?? null,
    [tenants, selectedTenantId]
  )

  function panelBadge(busy: boolean, error: string | null) {
    const background = busy ? '#fff6dd' : error ? '#fde8e8' : '#e8f7ee'
    const color = busy ? '#7a5b00' : error ? '#9b1c1c' : '#166534'
    const label = busy ? 'Loading' : error ? 'Error' : 'OK'
    return (
      <span
        style={{
          marginLeft: '0.5rem',
          padding: '0.15rem 0.45rem',
          borderRadius: 999,
          fontSize: '0.72rem',
          fontWeight: 700,
          letterSpacing: '0.02em',
          background,
          color,
        }}
      >
        {label}
      </span>
    )
  }

  async function refreshTenants(page = tenantPage): Promise<void> {
    setTenantLoadBusy(true)
    setTenantLoadError(null)
    try {
      const response = await rootApi.listTenants(page)
      setTenants(response.tenants)
      setTenantPage(response.page)
      setTenantHasMore(response.has_more)
      if (!selectedTenantId && response.tenants.length > 0) {
        setSelectedTenantId(response.tenants[0]!.tenant_id)
      }
    } catch (error) {
      setTenantLoadError(toUserErrorMessage(error, 'Failed to load tenants.'))
    } finally {
      setTenantLoadBusy(false)
    }
  }

  async function loadTenantDetails(tenantId: string): Promise<void> {
    const generation = ++detailGenerationRef.current
    detailAbortRef.current?.abort()
    if (!tenantId) {
      setBranding(null)
      setTenantAdmins([])
      setMessaging(null)
      setDemoMemberships([])
      setUsage(null)
      setTenantMemberships([])
      setMembershipHasMore(false)
      return
    }
    const controller = new AbortController()
    detailAbortRef.current = controller

    setBrandingBusy(true)
    setAdminLoadBusy(true)
    setMessagingBusy(true)
    setDemoLoadBusy(true)
    setUsageBusy(true)
    setMembershipLoadBusy(true)
    setBrandingError(null)
    setMessagingError(null)
    setDemoError(null)
    setUsageError(null)
    setMembershipError(null)

    const [brandingResult, adminsResult, messagingResult, demoResult, usageResult, membershipsResult] = await Promise.allSettled([
      rootApi.getTenantBranding(tenantId, controller.signal),
      rootApi.listTenantAdmins(tenantId, controller.signal),
      rootApi.getTenantMessaging(tenantId, controller.signal),
      rootApi.listDemoMemberships(tenantId, controller.signal),
      rootApi.getTenantUsage(tenantId, controller.signal),
      rootApi.listTenantMemberships(tenantId, membershipPage, 100, controller.signal),
    ])

    if (generation !== detailGenerationRef.current || controller.signal.aborted) return

    if (brandingResult.status === 'fulfilled') {
      setBranding(brandingResult.value)
    } else {
      setBranding(null)
      setBrandingError(toUserErrorMessage(brandingResult.reason, 'Failed to load tenant branding.'))
    }

    if (adminsResult.status === 'fulfilled') {
      setTenantAdmins(adminsResult.value.admins)
    } else {
      setTenantAdmins([])
      setAdminGrantError(toUserErrorMessage(adminsResult.reason, 'Failed to load tenant admin assignments.'))
    }

    if (messagingResult.status === 'fulfilled') {
      setMessaging(messagingResult.value)
    } else {
      setMessaging(null)
      setMessagingError(toUserErrorMessage(messagingResult.reason, 'Failed to load tenant messaging configuration.'))
    }

    if (demoResult.status === 'fulfilled') {
      setDemoMemberships(demoResult.value.memberships)
    } else {
      setDemoMemberships([])
      setDemoError(toUserErrorMessage(demoResult.reason, 'Failed to load demo memberships.'))
    }

    if (usageResult.status === 'fulfilled') {
      setUsage(usageResult.value)
    } else {
      setUsage(null)
      setUsageError(toUserErrorMessage(usageResult.reason, 'Failed to load tenant usage summary.'))
    }

    if (membershipsResult.status === 'fulfilled') {
      setTenantMemberships(membershipsResult.value.memberships)
      setMembershipHasMore(membershipsResult.value.has_more)
    } else {
      setTenantMemberships([])
      setMembershipHasMore(false)
      setMembershipError(toUserErrorMessage(membershipsResult.reason, 'Failed to load tenant memberships.'))
    }

    setBrandingBusy(false)
    setAdminLoadBusy(false)
    setMessagingBusy(false)
    setDemoLoadBusy(false)
    setUsageBusy(false)
    setMembershipLoadBusy(false)
  }

  useEffect(() => {
    if (!selectedTenantId) {
      return
    }
    setBrandingSuccess(null)
    setAdminGrantError(null)
    setAdminGrantSuccess(null)
    setMembershipSuccess(null)
    setDemoSuccess(null)
    setMessagingSuccess(null)
    setTenantStatusMessage(null)
    setMembershipPage(1)
  }, [selectedTenantId])

  useEffect(() => {
    let active = true

    async function bootstrap(): Promise<void> {
      try {
        const session = await rootApi.getSession()
        if (!active) return
        setIsRoot(Boolean(session.is_root))
        if (!session.is_root) {
          setSessionError('Root admin access is required to use this page.')
        }
      } catch (error) {
        if (!active) return
        setIsRoot(false)
        setSessionError(toUserErrorMessage(error, 'Failed to resolve root session.'))
      } finally {
        if (active) {
          setSessionReady(true)
        }
      }
    }

    void bootstrap()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!sessionReady || !isRoot) {
      return
    }
    void refreshTenants()
  }, [sessionReady, isRoot])

  useEffect(() => {
    if (!sessionReady || !isRoot || !selectedTenantId) {
      return
    }
    void loadTenantDetails(selectedTenantId)
    return () => {
      detailGenerationRef.current += 1
      detailAbortRef.current?.abort()
    }
  }, [membershipPage, sessionReady, isRoot, selectedTenantId])

  async function handleCreateTenant(): Promise<void> {
    if (tenantWriteRef.current) return
    tenantWriteRef.current = true
    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)
    try {
      const created = await rootApi.createTenant(createForm)
      setCreateSuccess(`Created tenant ${created.display_name} (${created.slug}).`)
      setCreateForm((current) => ({
        ...current,
        slug: '',
        display_name: '',
        initial_admin_email: '',
        initial_admin_display_name: '',
      }))
      await refreshTenants(1)
      setSelectedTenantId(created.tenant_id)
    } catch (error) {
      setCreateError(toUserErrorMessage(error, 'Failed to create tenant.'))
    } finally {
      finishTenantWrite()
      setCreateBusy(false)
    }
  }

  function openSelectedTenantAdmin(): void {
    if (!selectedTenantId) {
      return
    }
    selectTenant(selectedTenantId)
    navigate('/admin')
  }

  async function handleSaveBranding(): Promise<void> {
    if (!branding) return
    const tenantId = beginTenantWrite()
    if (!tenantId) return
    setBrandingSaveBusy(true)
    setBrandingError(null)
    setBrandingSuccess(null)
    try {
      const saved = await rootApi.upsertTenantBranding(tenantId, {
        org_long_name: branding.org_long_name,
        org_short_name: branding.org_short_name,
        support_email: branding.support_email,
        accessibility_email: branding.accessibility_email,
        logo_url: branding.logo_url,
        logo_dark_url: branding.logo_dark_url,
        hero_image_urls: branding.hero_image_urls,
        primary_color: branding.primary_color,
        accent_color: branding.accent_color,
        dark_color: branding.dark_color,
        program_tagline: branding.program_tagline,
        portal_login_url: branding.portal_login_url,
        mission_blurb: branding.mission_blurb,
      })
      if (!isCurrentTenant(tenantId)) return
      setBranding(saved)
      setBrandingSuccess(`Saved branding for ${selectedTenant?.display_name ?? 'tenant'}.`)
    } catch (error) {
      if (isCurrentTenant(tenantId)) setBrandingError(toUserErrorMessage(error, 'Failed to save branding.'))
    } finally {
      finishTenantWrite()
      setBrandingSaveBusy(false)
    }
  }

  async function handleRetryUsage(): Promise<void> {
    const tenantId = selectedTenantIdRef.current
    if (!tenantId) return
    setUsageBusy(true)
    setUsageError(null)
    try {
      const usageResponse = await rootApi.getTenantUsage(tenantId)
      if (!isCurrentTenant(tenantId)) return
      setUsage(usageResponse)
    } catch (error) {
      if (!isCurrentTenant(tenantId)) return
      setUsage(null)
      setUsageError(toUserErrorMessage(error, 'Failed to load tenant usage summary.'))
    } finally {
      setUsageBusy(false)
    }
  }

  async function handleRetryBranding(): Promise<void> {
    const tenantId = selectedTenantIdRef.current
    if (!tenantId) return
    setBrandingBusy(true)
    setBrandingError(null)
    try {
      const brandingResponse = await rootApi.getTenantBranding(tenantId)
      if (!isCurrentTenant(tenantId)) return
      setBranding(brandingResponse)
    } catch (error) {
      if (!isCurrentTenant(tenantId)) return
      setBranding(null)
      setBrandingError(toUserErrorMessage(error, 'Failed to load tenant branding.'))
    } finally {
      setBrandingBusy(false)
    }
  }

  async function handleRetryAdmins(): Promise<void> {
    const tenantId = selectedTenantIdRef.current
    if (!tenantId) return
    setAdminLoadBusy(true)
    setAdminGrantError(null)
    try {
      const adminsResponse = await rootApi.listTenantAdmins(tenantId)
      if (!isCurrentTenant(tenantId)) return
      setTenantAdmins(adminsResponse.admins)
    } catch (error) {
      if (!isCurrentTenant(tenantId)) return
      setTenantAdmins([])
      setAdminGrantError(toUserErrorMessage(error, 'Failed to load tenant admin assignments.'))
    } finally {
      setAdminLoadBusy(false)
    }
  }

  async function handleRetryMemberships(): Promise<void> {
    const tenantId = selectedTenantIdRef.current
    if (!tenantId) return
    setMembershipLoadBusy(true)
    setMembershipError(null)
    try {
      const membershipsResponse = await rootApi.listTenantMemberships(tenantId, membershipPage)
      if (!isCurrentTenant(tenantId)) return
      setTenantMemberships(membershipsResponse.memberships)
      setMembershipHasMore(membershipsResponse.has_more)
    } catch (error) {
      if (!isCurrentTenant(tenantId)) return
      setTenantMemberships([])
      setMembershipError(toUserErrorMessage(error, 'Failed to load tenant memberships.'))
    } finally {
      setMembershipLoadBusy(false)
    }
  }

  async function handleRetryMessaging(): Promise<void> {
    const tenantId = selectedTenantIdRef.current
    if (!tenantId) return
    setMessagingBusy(true)
    setMessagingError(null)
    try {
      const messagingResponse = await rootApi.getTenantMessaging(tenantId)
      if (!isCurrentTenant(tenantId)) return
      setMessaging(messagingResponse)
    } catch (error) {
      if (!isCurrentTenant(tenantId)) return
      setMessaging(null)
      setMessagingError(toUserErrorMessage(error, 'Failed to load tenant messaging configuration.'))
    } finally {
      setMessagingBusy(false)
    }
  }

  async function handleBlobUpload(file: File, assetKind: TenantBrandingAssetKind): Promise<void> {
    if (!branding) return
    const tenantId = beginTenantWrite()
    if (!tenantId) return

    setBrandingSaveBusy(true)
    setBrandingError(null)
    setBrandingSuccess(null)

    try {
      const upload = await rootApi.createBrandingAssetUploadUrl(tenantId, {
        file_name: file.name,
        content_type: file.type || 'application/octet-stream',
        asset_kind: assetKind,
      })

      const uploadResponse = await fetch(upload.upload_url, {
        method: 'PUT',
        headers: upload.required_headers,
        body: file,
      })

      if (!uploadResponse.ok) {
        throw new Error(`Blob upload failed with status ${uploadResponse.status}`)
      }

      const committed = await rootApi.commitBrandingAsset(tenantId, {
        asset_kind: assetKind,
        asset_url: upload.blob_url,
      })

      if (!isCurrentTenant(tenantId)) return
      setBranding(committed)
      setBrandingSuccess(`Uploaded and linked ${assetKind.replace('_', ' ')} image.`)
    } catch (error) {
      if (isCurrentTenant(tenantId)) setBrandingError(toUserErrorMessage(error, 'Failed to upload branding asset.'))
    } finally {
      finishTenantWrite()
      setBrandingSaveBusy(false)
    }
  }

  async function handleGrantAdmin(): Promise<void> {
    const tenantId = beginTenantWrite()
    if (!tenantId) return

    setAdminGrantBusy(true)
    setAdminGrantError(null)
    setAdminGrantSuccess(null)
    try {
      const result = await rootApi.grantTenantAdmin(tenantId, {
        email: adminEmail.trim(),
        display_name: adminDisplayName.trim() || null,
        expires_at: adminExpiresAt ? new Date(adminExpiresAt).toISOString() : null,
      })
      if (!isCurrentTenant(tenantId)) return
      setTenantAdmins(result.admins)
      setAdminGrantSuccess(`Granted admin access to ${adminEmail.trim()}.`)
      setAdminEmail('')
      setAdminDisplayName('')
      setAdminExpiresAt('')
    } catch (error) {
      if (isCurrentTenant(tenantId)) setAdminGrantError(toUserErrorMessage(error, 'Failed to grant tenant admin access.'))
    } finally {
      finishTenantWrite()
      setAdminGrantBusy(false)
    }
  }

  async function handleRevokeAdmin(userId: string, adminEmailValue: string): Promise<void> {
    const tenantId = beginTenantWrite()
    if (!tenantId) return

    setAdminRevokeBusyUserId(userId)
    setAdminGrantError(null)
    setAdminGrantSuccess(null)
    try {
      const result = await rootApi.revokeTenantAdmin(tenantId, userId)
      if (!isCurrentTenant(tenantId)) return
      setTenantAdmins(result.admins)
      setAdminGrantSuccess(`Revoked admin access for ${adminEmailValue}.`)
    } catch (error) {
      if (isCurrentTenant(tenantId)) setAdminGrantError(toUserErrorMessage(error, 'Failed to revoke tenant admin access.'))
    } finally {
      finishTenantWrite()
      setAdminRevokeBusyUserId(null)
    }
  }

  async function handleSetTenantSuspended(action: 'suspend' | 'reactivate'): Promise<void> {
    const tenantId = beginTenantWrite()
    if (!tenantId) return

    setTenantStatusBusy(true)
    setTenantStatusMessage(null)
    setTenantLoadError(null)
    try {
      await rootApi.setTenantSuspended(tenantId, { action })
      if (!isCurrentTenant(tenantId)) return
      await refreshTenants()
      if (!isCurrentTenant(tenantId)) return
      setTenantStatusMessage(action === 'suspend' ? 'Tenant suspended.' : 'Tenant reactivated.')
    } catch (error) {
      if (isCurrentTenant(tenantId)) setTenantLoadError(toUserErrorMessage(error, 'Failed to update tenant status.'))
    } finally {
      finishTenantWrite()
      setTenantStatusBusy(false)
    }
  }

  async function handleGrantTenantMembership(): Promise<void> {
    if (!membershipEmail.trim()) return
    const tenantId = beginTenantWrite()
    if (!tenantId) return

    setMembershipBusy(true)
    setMembershipError(null)
    setMembershipSuccess(null)
    try {
      const response = await rootApi.grantTenantMembership(tenantId, {
        email: membershipEmail.trim(),
        display_name: membershipDisplayName.trim() || null,
        role: membershipRole,
        membership_kind: membershipKind,
        expires_at: membershipExpiresAt ? new Date(membershipExpiresAt).toISOString() : null,
      })
      if (!isCurrentTenant(tenantId)) return
      setTenantMemberships(response.memberships)
      setMembershipSuccess(`Granted ${membershipRole} ${membershipKind} membership to ${membershipEmail.trim()}.`)
      setMembershipEmail('')
      setMembershipDisplayName('')
      setMembershipExpiresAt('')
    } catch (error) {
      if (isCurrentTenant(tenantId)) setMembershipError(toUserErrorMessage(error, 'Failed to grant tenant membership.'))
    } finally {
      finishTenantWrite()
      setMembershipBusy(false)
    }
  }

  async function handleRevokeTenantMembership(membershipId: string): Promise<void> {
    const tenantId = beginTenantWrite()
    if (!tenantId) return

    setMembershipBusy(true)
    setMembershipError(null)
    setMembershipSuccess(null)
    try {
      const response = await rootApi.updateTenantMembership(tenantId, membershipId, { status: 'revoked' })
      if (!isCurrentTenant(tenantId)) return
      setTenantMemberships(response.memberships)
      setMembershipSuccess('Membership revoked.')
    } catch (error) {
      if (isCurrentTenant(tenantId)) setMembershipError(toUserErrorMessage(error, 'Failed to revoke tenant membership.'))
    } finally {
      finishTenantWrite()
      setMembershipBusy(false)
    }
  }

  async function handleSaveMessaging(): Promise<void> {
    if (!messaging) return
    const tenantId = beginTenantWrite()
    if (!tenantId) return

    setMessagingSaveBusy(true)
    setMessagingError(null)
    setMessagingSuccess(null)

    try {
      const saved = await rootApi.upsertTenantMessaging(tenantId, {
        email_from: messaging.email_from,
        email_reply_to: messaging.email_reply_to,
        email_bcc_monitor: messaging.email_bcc_monitor,
        sms_provider: messaging.sms_provider,
        sms_from: messaging.sms_from,
        twilio_messaging_service_sid: messaging.twilio_messaging_service_sid,
        telnyx_messaging_profile_id: messaging.telnyx_messaging_profile_id,
        telnyx_from_number: messaging.telnyx_from_number,
      })
      if (!isCurrentTenant(tenantId)) return
      setMessaging(saved)
      setMessagingSuccess(`Saved tenant messaging for ${selectedTenant?.display_name ?? 'tenant'}.`)
    } catch (error) {
      if (isCurrentTenant(tenantId)) setMessagingError(toUserErrorMessage(error, 'Failed to save tenant messaging.'))
    } finally {
      finishTenantWrite()
      setMessagingSaveBusy(false)
    }
  }

  async function handleGrantDemoAccess(): Promise<void> {
    if (!demoExpiresAt || !demoEmail.trim()) {
      return
    }
    const tenantId = beginTenantWrite()
    if (!tenantId) return

    setDemoGrantBusy(true)
    setDemoError(null)
    setDemoSuccess(null)

    try {
      const result = await rootApi.grantDemoMembership(tenantId, {
        email: demoEmail.trim(),
        display_name: demoDisplayName.trim() || null,
        expires_at: new Date(demoExpiresAt).toISOString(),
      })
      if (!isCurrentTenant(tenantId)) return
      setDemoMemberships(result.memberships)
      setDemoSuccess(`Granted temporary demo access to ${demoEmail.trim()}.`)
      setDemoEmail('')
      setDemoDisplayName('')
      setDemoExpiresAt('')
    } catch (error) {
      if (isCurrentTenant(tenantId)) setDemoError(toUserErrorMessage(error, 'Failed to grant demo access.'))
    } finally {
      finishTenantWrite()
      setDemoGrantBusy(false)
    }
  }

  async function handleRevokeDemoAccess(membershipId: string): Promise<void> {
    const tenantId = beginTenantWrite()
    if (!tenantId) return

    setDemoGrantBusy(true)
    setDemoError(null)
    setDemoSuccess(null)
    try {
      const result = await rootApi.revokeDemoMembership(tenantId, membershipId)
      if (!isCurrentTenant(tenantId)) return
      setDemoMemberships(result.memberships)
      setDemoSuccess('Revoked demo access membership.')
    } catch (error) {
      if (isCurrentTenant(tenantId)) setDemoError(toUserErrorMessage(error, 'Failed to revoke demo access.'))
    } finally {
      finishTenantWrite()
      setDemoGrantBusy(false)
    }
  }

  async function handleResetDemoAccess(): Promise<void> {
    const tenantId = beginTenantWrite()
    if (!tenantId) return

    setDemoResetBusy(true)
    setDemoError(null)
    setDemoSuccess(null)
    try {
      const result = await rootApi.resetDemoMemberships(tenantId)
      if (!isCurrentTenant(tenantId)) return
      setDemoMemberships(result.memberships)
      const reseedSummary = result.reseed.reseeded
        ? ` Reseeded ${result.reseed.members_seeded} members, ${result.reseed.events_seeded} events, and ${result.reseed.responses_seeded} responses.`
        : result.reseed.skipped_reason
          ? ` Reseed skipped: ${result.reseed.skipped_reason}.`
          : ''
      setDemoSuccess(`Revoked ${result.revoked_count} active demo memberships.${reseedSummary}`)
    } catch (error) {
      if (isCurrentTenant(tenantId)) setDemoError(toUserErrorMessage(error, 'Failed to reset demo memberships.'))
    } finally {
      finishTenantWrite()
      setDemoResetBusy(false)
    }
  }

  if (!sessionReady) {
    return <section className="page"><p>Loading root session…</p></section>
  }

  if (!isRoot) {
    return (
      <section className="page">
        <h1>Root Tenant Administration</h1>
        <p className="ui-notice ui-notice--error">{sessionError ?? 'Root admin access is required.'}</p>
        <p><Link to="/admin">Back to admin dashboard</Link></p>
      </section>
    )
  }

  return (
    <section className="page">
      <h1>Root Tenant Administration</h1>
      <p className="admin-note">Create tenants, monitor usage, and manage demo lifecycle. Tenant branding, messaging metadata, and tenant access are managed inside the tenant admin portal.</p>

      <section className="admin-card" style={{ marginBottom: '1rem' }}>
        <h2 className="admin-section-title">Create Tenant</h2>
        {createError && <p className="ui-notice ui-notice--error">{createError}</p>}
        {createSuccess && <p className="ui-notice ui-notice--success">{createSuccess}</p>}
        <div className="admin-grid admin-grid--3" style={{ marginBottom: '0.75rem' }}>
          <input className="members-input" placeholder="slug (e.g. montrose)" value={createForm.slug} onChange={(e) => setCreateForm((c) => ({ ...c, slug: e.target.value }))} />
          <input className="members-input" placeholder="display name" value={createForm.display_name} onChange={(e) => setCreateForm((c) => ({ ...c, display_name: e.target.value }))} />
          <input className="members-input" type="email" placeholder="initial admin email" value={createForm.initial_admin_email} onChange={(e) => setCreateForm((c) => ({ ...c, initial_admin_email: e.target.value }))} />
          <input className="members-input" placeholder="initial admin display name (optional)" value={createForm.initial_admin_display_name} onChange={(e) => setCreateForm((c) => ({ ...c, initial_admin_display_name: e.target.value }))} />
          <input className="members-input" placeholder="timezone" value={createForm.timezone} onChange={(e) => setCreateForm((c) => ({ ...c, timezone: e.target.value }))} />
          <select className="members-input" value={createForm.tenant_type} onChange={(e) => setCreateForm((c) => ({ ...c, tenant_type: e.target.value as TenantCreateForm['tenant_type'] }))}>
            <option value="program">program</option>
            <option value="demo">demo</option>
            <option value="system">system</option>
          </select>
          <select className="members-input" value={createForm.status} onChange={(e) => setCreateForm((c) => ({ ...c, status: e.target.value as TenantCreateForm['status'] }))}>
            <option value="active">active</option>
            <option value="suspended">suspended</option>
            <option value="archived">archived</option>
          </select>
          <button className="btn btn--primary btn--sm" disabled={writeBusy || !createForm.slug.trim() || !createForm.display_name.trim() || !createForm.initial_admin_email.includes('@')} onClick={() => void handleCreateTenant()}>
            {createBusy ? 'Creating…' : 'Create Tenant'}
          </button>
        </div>
      </section>

      <section className="admin-card" style={{ marginBottom: '1rem' }}>
        <h2 className="admin-section-title">Existing Tenants</h2>
        {tenantLoadError && <p className="ui-notice ui-notice--error">{tenantLoadError}</p>}
        {tenantLoadBusy ? (
          <p>Loading tenants…</p>
        ) : tenants.length === 0 ? (
          <p className="admin-note">No tenants found yet.</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {tenants.map((tenant) => (
              <button
                key={tenant.tenant_id}
                className={tenant.tenant_id === selectedTenantId ? 'btn btn--primary btn--sm' : 'btn btn--outline btn--sm'}
                disabled={writeBusy}
                onClick={() => setSelectedTenantId(tenant.tenant_id)}
              >
                {tenant.display_name} ({tenant.slug})
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <button className="btn btn--outline btn--sm" disabled={tenantLoadBusy || writeBusy || tenantPage <= 1} onClick={() => void refreshTenants(tenantPage - 1)}>Previous</button>
          <span className="admin-note">Page {tenantPage}</span>
          <button className="btn btn--outline btn--sm" disabled={tenantLoadBusy || writeBusy || !tenantHasMore} onClick={() => void refreshTenants(tenantPage + 1)}>Next</button>
        </div>
      </section>

      <section className="admin-card" style={{ marginBottom: '1rem' }}>
        <h2 className="admin-section-title">Tenant-Scoped Controls</h2>
        <p className="admin-note">
          Branding, tenant messaging metadata (email from/reply-to/BCC), tenant admin grants, and tenant memberships are managed in Admin within the active tenant context.
        </p>
        <button className="btn btn--primary btn--sm" disabled={!selectedTenantId} onClick={openSelectedTenantAdmin}>
          Open selected tenant in Admin
        </button>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', alignItems: 'center' }}>
          <button className="btn btn--outline btn--sm" disabled={membershipLoadBusy || writeBusy || membershipPage <= 1} onClick={() => setMembershipPage((page) => page - 1)}>Previous memberships</button>
          <span className="admin-note">Membership page {membershipPage} ({tenantMemberships.length} loaded)</span>
          <button className="btn btn--outline btn--sm" disabled={membershipLoadBusy || writeBusy || !membershipHasMore} onClick={() => setMembershipPage((page) => page + 1)}>Next memberships</button>
        </div>
      </section>

      <section className="admin-card" style={{ marginBottom: '1rem' }}>
        <h2 className="admin-section-title">Demo Access Lifecycle</h2>
        <p className="admin-note" style={{ marginBottom: '0.75rem' }}>
          Grant expiring temporary demo memberships and revoke or reset them in one place.
        </p>
        {demoError && <p className="ui-notice ui-notice--error">{demoError}</p>}
        {demoSuccess && <p className="ui-notice ui-notice--success">{demoSuccess}</p>}

        {selectedTenant?.is_demo ? (
          <>
            <div className="admin-grid admin-grid--3" style={{ marginBottom: '0.75rem' }}>
              <input className="members-input" placeholder="user email" value={demoEmail} onChange={(e) => setDemoEmail(e.target.value)} />
              <input className="members-input" placeholder="display name (optional)" value={demoDisplayName} onChange={(e) => setDemoDisplayName(e.target.value)} />
              <input className="members-input" type="datetime-local" value={demoExpiresAt} onChange={(e) => setDemoExpiresAt(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
              <button className="btn btn--primary btn--sm" disabled={writeBusy || !demoEmail.trim() || !demoExpiresAt} onClick={() => void handleGrantDemoAccess()}>
                {demoGrantBusy ? 'Granting…' : 'Grant Demo Access'}
              </button>
              <button className="btn btn--secondary btn--sm" disabled={writeBusy} onClick={() => void handleResetDemoAccess()}>
                {demoResetBusy ? 'Resetting…' : 'Reset All Demo Access'}
              </button>
            </div>

            {demoLoadBusy ? (
              <p>Loading demo memberships…</p>
            ) : demoMemberships.length === 0 ? (
              <p className="admin-note">No active temporary demo memberships.</p>
            ) : (
              <ul>
                {demoMemberships.map((membership) => (
                  <li key={membership.tenant_membership_id} style={{ marginBottom: '0.35rem' }}>
                    <strong>{membership.email}</strong>
                    {membership.display_name ? ` (${membership.display_name})` : ''}
                    {membership.expires_at ? ` • expires ${new Date(membership.expires_at).toLocaleString()}` : ''}
                    {' '}
                    <button className="btn btn--outline btn--sm" disabled={writeBusy} onClick={() => void handleRevokeDemoAccess(membership.tenant_membership_id)}>
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="admin-note">Select a tenant marked as demo to manage temporary demo memberships.</p>
        )}
      </section>

      <section className="admin-card" style={{ marginBottom: '1rem' }}>
        <h2 className="admin-section-title">Tenant Selection</h2>
        {tenantLoadError && <p className="ui-notice ui-notice--error">{tenantLoadError}</p>}
        {tenantStatusMessage && <p className="ui-notice ui-notice--success">{tenantStatusMessage}</p>}
        <div className="admin-grid admin-grid--2">
          <select className="members-input" value={selectedTenantId} onChange={(e) => setSelectedTenantId(e.target.value)} disabled={tenantLoadBusy || writeBusy || tenants.length === 0}>
            {tenants.map((tenant) => (
              <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.display_name} ({tenant.slug})</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn btn--secondary btn--sm" disabled={tenantLoadBusy || writeBusy} onClick={() => void refreshTenants()}>
              {tenantLoadBusy ? 'Refreshing…' : 'Refresh Tenants'}
            </button>
            {selectedTenant?.status === 'suspended' ? (
              <button className="btn btn--primary btn--sm" disabled={writeBusy} onClick={() => void handleSetTenantSuspended('reactivate')}>
                {tenantStatusBusy ? 'Applying…' : 'Reactivate Tenant'}
              </button>
            ) : (
              <button className="btn btn--outline btn--sm" disabled={writeBusy || !selectedTenantId} onClick={() => void handleSetTenantSuspended('suspend')}>
                {tenantStatusBusy ? 'Applying…' : 'Suspend Tenant'}
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="admin-card" style={{ marginBottom: '1rem' }}>
        <h2 className="admin-section-title">
          Tenant Usage Summary
          {panelBadge(usageBusy, usageError)}
        </h2>
        {usageError && <p className="ui-notice ui-notice--error">{usageError}</p>}
        <button className="btn btn--outline btn--sm" style={{ marginBottom: '0.75rem' }} disabled={usageBusy || !selectedTenantId} onClick={() => void handleRetryUsage()}>
          {usageBusy ? 'Retrying…' : 'Retry Usage'}
        </button>
        {usageBusy ? (
          <p>Loading usage metrics…</p>
        ) : usage ? (
          <div className="admin-grid admin-grid--3">
            <div><strong>Members:</strong> {usage.members_total}</div>
            <div><strong>Events:</strong> {usage.events_total}</div>
            <div><strong>Event responses:</strong> {usage.event_responses_total}</div>
            <div><strong>Notifications:</strong> {usage.notifications_total}</div>
            <div><strong>Failed notifications:</strong> {usage.notification_failures_total}</div>
            <div><strong>Email opt-outs:</strong> {usage.email_opt_out_total}</div>
            <div><strong>SMS opt-outs:</strong> {usage.sms_opt_out_total}</div>
            <div><strong>Calculated:</strong> {new Date(usage.calculated_at).toLocaleString()}</div>
          </div>
        ) : (
          <p className="admin-note">No usage summary available for this tenant.</p>
        )}
      </section>

      <section className="admin-card" style={{ marginBottom: '1rem' }}>
        <h2 className="admin-section-title">Blob CORS Helper</h2>
        <p className="admin-note" style={{ marginBottom: '0.5rem' }}>
          Detected Azure topology in this subscription:
        </p>
        <ul style={{ marginTop: 0 }}>
          <li>Frontend production host: {frontendProdHost}</li>
          <li>Backend production host: {backendProdHost}</li>
          <li>Backend staging slot host: {backendStagingHost}</li>
          <li>
            Frontend staging slot host: {frontendStagingHost ?? 'not detected'}
            {!frontendStagingHost ? ' (no frontend staging slot exists yet)' : ''}
          </li>
        </ul>

        <p className="admin-note" style={{ marginBottom: '0.5rem' }}>
          Browser-direct Blob uploads require CORS on the storage account. Apply this template with your storage account values:
        </p>
        <pre style={{
          background: '#f4f4f4',
          border: '1px solid #ddd',
          borderRadius: 6,
          padding: '0.75rem',
          overflowX: 'auto',
          fontSize: '0.8rem',
          marginBottom: '0.5rem',
        }}>{`az storage cors add \\
  --services b \\
  --origins ${frontendProdHost} https://app.phwcoloradoalpine.org \\
  --methods GET PUT OPTIONS HEAD \\
  --allowed-headers "*" \\
  --exposed-headers "ETag,x-ms-request-id,x-ms-version" \\
  --max-age 3600 \\
  --account-name <storage-account-name> \\
  --account-key <storage-account-key>`}</pre>

        <p className="admin-note" style={{ marginBottom: 0 }}>
          If you add a frontend staging slot later, include that staging frontend origin in CORS origins before running staging upload tests.
        </p>
      </section>

    </section>
  )
}

export { RootAdminPage }
