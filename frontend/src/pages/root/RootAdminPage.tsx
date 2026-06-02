import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { rootApi } from '../../api/root'
import type {
  RootTenantAdminSummary,
  RootTenantBranding,
  RootTenantSummary,
  TenantBrandingAssetKind,
} from '../../api/root'
import { toUserErrorMessage } from '../../utils/errorMessage'

type TenantCreateForm = {
  slug: string
  display_name: string
  tenant_type: 'program' | 'demo' | 'system'
  status: 'active' | 'suspended' | 'archived'
  timezone: string
}

function RootAdminPage() {
  const [sessionReady, setSessionReady] = useState(false)
  const [isRoot, setIsRoot] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)

  const [tenants, setTenants] = useState<RootTenantSummary[]>([])
  const [tenantLoadBusy, setTenantLoadBusy] = useState(false)
  const [tenantLoadError, setTenantLoadError] = useState<string | null>(null)

  const [createForm, setCreateForm] = useState<TenantCreateForm>({
    slug: '',
    display_name: '',
    tenant_type: 'program',
    status: 'active',
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
  const [adminEmail, setAdminEmail] = useState('')
  const [adminDisplayName, setAdminDisplayName] = useState('')
  const [adminExpiresAt, setAdminExpiresAt] = useState('')

  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.tenant_id === selectedTenantId) ?? null,
    [tenants, selectedTenantId]
  )

  async function refreshTenants(): Promise<void> {
    setTenantLoadBusy(true)
    setTenantLoadError(null)
    try {
      const response = await rootApi.listTenants()
      setTenants(response.tenants)
      if (!selectedTenantId && response.tenants.length > 0) {
        setSelectedTenantId(response.tenants[0]!.tenant_id)
      }
    } catch (error) {
      setTenantLoadError(toUserErrorMessage(error, 'Failed to load tenants.'))
    } finally {
      setTenantLoadBusy(false)
    }
  }

  async function loadBrandingAndAdmins(tenantId: string): Promise<void> {
    if (!tenantId) {
      setBranding(null)
      setTenantAdmins([])
      return
    }

    setBrandingBusy(true)
    setAdminLoadBusy(true)
    setBrandingError(null)

    try {
      const [brandingResponse, adminsResponse] = await Promise.all([
        rootApi.getTenantBranding(tenantId),
        rootApi.listTenantAdmins(tenantId),
      ])
      setBranding(brandingResponse)
      setTenantAdmins(adminsResponse.admins)
    } catch (error) {
      setBranding(null)
      setTenantAdmins([])
      setBrandingError(toUserErrorMessage(error, 'Failed to load tenant branding/admin assignments.'))
    } finally {
      setBrandingBusy(false)
      setAdminLoadBusy(false)
    }
  }

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
    void loadBrandingAndAdmins(selectedTenantId)
  }, [sessionReady, isRoot, selectedTenantId])

  async function handleCreateTenant(): Promise<void> {
    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)
    try {
      const created = await rootApi.createTenant(createForm)
      setCreateSuccess(`Created tenant ${created.display_name} (${created.slug}).`)
      setCreateForm((current) => ({ ...current, slug: '', display_name: '' }))
      await refreshTenants()
      setSelectedTenantId(created.tenant_id)
    } catch (error) {
      setCreateError(toUserErrorMessage(error, 'Failed to create tenant.'))
    } finally {
      setCreateBusy(false)
    }
  }

  async function handleSaveBranding(): Promise<void> {
    if (!selectedTenantId || !branding) {
      return
    }
    setBrandingSaveBusy(true)
    setBrandingError(null)
    setBrandingSuccess(null)
    try {
      const saved = await rootApi.upsertTenantBranding(selectedTenantId, {
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
      setBranding(saved)
      setBrandingSuccess(`Saved branding for ${selectedTenant?.display_name ?? 'tenant'}.`)
    } catch (error) {
      setBrandingError(toUserErrorMessage(error, 'Failed to save branding.'))
    } finally {
      setBrandingSaveBusy(false)
    }
  }

  async function handleBlobUpload(file: File, assetKind: TenantBrandingAssetKind): Promise<void> {
    if (!selectedTenantId || !branding) {
      return
    }

    setBrandingSaveBusy(true)
    setBrandingError(null)
    setBrandingSuccess(null)

    try {
      const upload = await rootApi.createBrandingAssetUploadUrl(selectedTenantId, {
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

      const committed = await rootApi.commitBrandingAsset(selectedTenantId, {
        asset_kind: assetKind,
        asset_url: upload.blob_url,
      })

      setBranding(committed)
      setBrandingSuccess(`Uploaded and linked ${assetKind.replace('_', ' ')} image.`)
    } catch (error) {
      setBrandingError(toUserErrorMessage(error, 'Failed to upload branding asset.'))
    } finally {
      setBrandingSaveBusy(false)
    }
  }

  async function handleGrantAdmin(): Promise<void> {
    if (!selectedTenantId) {
      return
    }

    setAdminGrantBusy(true)
    setAdminGrantError(null)
    setAdminGrantSuccess(null)
    try {
      const result = await rootApi.grantTenantAdmin(selectedTenantId, {
        email: adminEmail.trim(),
        display_name: adminDisplayName.trim() || null,
        expires_at: adminExpiresAt ? new Date(adminExpiresAt).toISOString() : null,
      })
      setTenantAdmins(result.admins)
      setAdminGrantSuccess(`Granted admin access to ${adminEmail.trim()}.`)
      setAdminEmail('')
      setAdminDisplayName('')
      setAdminExpiresAt('')
    } catch (error) {
      setAdminGrantError(toUserErrorMessage(error, 'Failed to grant tenant admin access.'))
    } finally {
      setAdminGrantBusy(false)
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
      <p className="admin-note">Create tenants, manage branding with Blob-backed image uploads, and grant tenant admins.</p>

      <section className="admin-card" style={{ marginBottom: '1rem' }}>
        <h2 className="admin-section-title">Create Tenant</h2>
        {createError && <p className="ui-notice ui-notice--error">{createError}</p>}
        {createSuccess && <p className="ui-notice ui-notice--success">{createSuccess}</p>}
        <div className="admin-grid admin-grid--3" style={{ marginBottom: '0.75rem' }}>
          <input className="members-input" placeholder="slug (e.g. montrose)" value={createForm.slug} onChange={(e) => setCreateForm((c) => ({ ...c, slug: e.target.value }))} />
          <input className="members-input" placeholder="display name" value={createForm.display_name} onChange={(e) => setCreateForm((c) => ({ ...c, display_name: e.target.value }))} />
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
          <button className="btn btn--primary btn--sm" disabled={createBusy || !createForm.slug.trim() || !createForm.display_name.trim()} onClick={() => void handleCreateTenant()}>
            {createBusy ? 'Creating…' : 'Create Tenant'}
          </button>
        </div>
      </section>

      <section className="admin-card" style={{ marginBottom: '1rem' }}>
        <h2 className="admin-section-title">Tenant Selection</h2>
        {tenantLoadError && <p className="ui-notice ui-notice--error">{tenantLoadError}</p>}
        <div className="admin-grid admin-grid--2">
          <select className="members-input" value={selectedTenantId} onChange={(e) => setSelectedTenantId(e.target.value)} disabled={tenantLoadBusy || tenants.length === 0}>
            {tenants.map((tenant) => (
              <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.display_name} ({tenant.slug})</option>
            ))}
          </select>
          <button className="btn btn--secondary btn--sm" disabled={tenantLoadBusy} onClick={() => void refreshTenants()}>
            {tenantLoadBusy ? 'Refreshing…' : 'Refresh Tenants'}
          </button>
        </div>
      </section>

      <section className="admin-card" style={{ marginBottom: '1rem' }}>
        <h2 className="admin-section-title">Branding Editor</h2>
        {brandingError && <p className="ui-notice ui-notice--error">{brandingError}</p>}
        {brandingSuccess && <p className="ui-notice ui-notice--success">{brandingSuccess}</p>}

        {!selectedTenantId || brandingBusy ? (
          <p>Loading branding…</p>
        ) : branding ? (
          <>
            <div className="admin-grid admin-grid--2" style={{ marginBottom: '0.75rem' }}>
              <input className="members-input" value={branding.org_long_name ?? ''} placeholder="Org long name" onChange={(e) => setBranding((current) => current ? { ...current, org_long_name: e.target.value } : current)} />
              <input className="members-input" value={branding.org_short_name ?? ''} placeholder="Org short name" onChange={(e) => setBranding((current) => current ? { ...current, org_short_name: e.target.value } : current)} />
              <input className="members-input" value={branding.support_email ?? ''} placeholder="Support email" onChange={(e) => setBranding((current) => current ? { ...current, support_email: e.target.value } : current)} />
              <input className="members-input" value={branding.accessibility_email ?? ''} placeholder="Accessibility email" onChange={(e) => setBranding((current) => current ? { ...current, accessibility_email: e.target.value } : current)} />
              <input className="members-input" value={branding.primary_color ?? ''} placeholder="Primary color (#hex)" onChange={(e) => setBranding((current) => current ? { ...current, primary_color: e.target.value } : current)} />
              <input className="members-input" value={branding.accent_color ?? ''} placeholder="Accent color (#hex)" onChange={(e) => setBranding((current) => current ? { ...current, accent_color: e.target.value } : current)} />
              <input className="members-input" value={branding.dark_color ?? ''} placeholder="Dark color (#hex)" onChange={(e) => setBranding((current) => current ? { ...current, dark_color: e.target.value } : current)} />
              <input className="members-input" value={branding.portal_login_url ?? ''} placeholder="Portal login URL" onChange={(e) => setBranding((current) => current ? { ...current, portal_login_url: e.target.value } : current)} />
            </div>

            <textarea className="members-input" rows={3} value={branding.program_tagline ?? ''} placeholder="Program tagline" onChange={(e) => setBranding((current) => current ? { ...current, program_tagline: e.target.value } : current)} style={{ marginBottom: '0.5rem' }} />
            <textarea className="members-input" rows={4} value={branding.mission_blurb ?? ''} placeholder="Mission blurb" onChange={(e) => setBranding((current) => current ? { ...current, mission_blurb: e.target.value } : current)} style={{ marginBottom: '0.75rem' }} />

            <div className="admin-grid admin-grid--3" style={{ marginBottom: '0.75rem' }}>
              <label className="members-field-label">
                Logo upload
                <input className="members-input" type="file" accept="image/*" onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void handleBlobUpload(file, 'logo')
                  e.currentTarget.value = ''
                }} />
              </label>
              <label className="members-field-label">
                Dark logo upload
                <input className="members-input" type="file" accept="image/*" onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void handleBlobUpload(file, 'logo_dark')
                  e.currentTarget.value = ''
                }} />
              </label>
              <label className="members-field-label">
                Hero upload
                <input className="members-input" type="file" accept="image/*" onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void handleBlobUpload(file, 'hero')
                  e.currentTarget.value = ''
                }} />
              </label>
            </div>

            <button className="btn btn--primary btn--sm" disabled={brandingSaveBusy} onClick={() => void handleSaveBranding()}>
              {brandingSaveBusy ? 'Saving…' : 'Save Branding'}
            </button>
          </>
        ) : (
          <p className="admin-note">No branding found for this tenant.</p>
        )}
      </section>

      <section className="admin-card">
        <h2 className="admin-section-title">Tenant Admin Grants</h2>
        {adminGrantError && <p className="ui-notice ui-notice--error">{adminGrantError}</p>}
        {adminGrantSuccess && <p className="ui-notice ui-notice--success">{adminGrantSuccess}</p>}
        <div className="admin-grid admin-grid--3" style={{ marginBottom: '0.75rem' }}>
          <input className="members-input" placeholder="admin email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
          <input className="members-input" placeholder="display name (optional)" value={adminDisplayName} onChange={(e) => setAdminDisplayName(e.target.value)} />
          <input className="members-input" type="datetime-local" value={adminExpiresAt} onChange={(e) => setAdminExpiresAt(e.target.value)} />
          <button className="btn btn--primary btn--sm" disabled={adminGrantBusy || !adminEmail.trim() || !selectedTenantId} onClick={() => void handleGrantAdmin()}>
            {adminGrantBusy ? 'Granting…' : 'Grant Tenant Admin'}
          </button>
        </div>

        {adminLoadBusy ? (
          <p>Loading tenant admins…</p>
        ) : tenantAdmins.length === 0 ? (
          <p className="admin-note">No active tenant admins assigned.</p>
        ) : (
          <ul>
            {tenantAdmins.map((admin) => (
              <li key={admin.tenant_membership_id}>
                <strong>{admin.email}</strong>
                {admin.display_name ? ` (${admin.display_name})` : ''}
                {admin.expires_at ? ` • expires ${new Date(admin.expires_at).toLocaleString()}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}

export { RootAdminPage }
