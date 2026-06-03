import { describe, expect, it } from 'vitest'
import { chooseDefaultTenant, dedupeTenantContexts } from '../TenantContext'
import type { UserTenantContext } from '../../api/me'

function makeTenant(overrides: Partial<UserTenantContext>): UserTenantContext {
  return {
    tenant_id: '11111111-1111-4111-8111-111111111111',
    slug: 'colorado-alpine',
    display_name: 'Colorado Alpine',
    tenant_type: 'program',
    is_demo: false,
    role: 'member',
    membership_kind: 'home',
    expires_at: null,
    branding: null,
    ...overrides,
  }
}

describe('chooseDefaultTenant', () => {
  it('uses persisted tenant when valid', () => {
    const home = makeTenant({ tenant_id: '11111111-1111-4111-8111-111111111111' })
    const demo = makeTenant({
      tenant_id: '22222222-2222-4222-8222-222222222222',
      slug: 'demo',
      display_name: 'Demo',
      is_demo: true,
      membership_kind: 'temporary_demo',
    })

    const result = chooseDefaultTenant([home, demo], '22222222-2222-4222-8222-222222222222')
    expect(result.activeTenantId).toBe(demo.tenant_id)
    expect(result.needsSelection).toBe(false)
  })

  it('auto-selects single tenant with no picker requirement', () => {
    const home = makeTenant({})
    const result = chooseDefaultTenant([home], null)
    expect(result.activeTenantId).toBe(home.tenant_id)
    expect(result.needsSelection).toBe(false)
  })

  it('shows picker when multiple tenants and no persisted selection', () => {
    const home = makeTenant({ tenant_id: '11111111-1111-4111-8111-111111111111' })
    const demo = makeTenant({
      tenant_id: '22222222-2222-4222-8222-222222222222',
      slug: 'demo',
      display_name: 'Demo',
      is_demo: true,
      membership_kind: 'temporary_demo',
    })

    const result = chooseDefaultTenant([home, demo], null)
    expect(result.activeTenantId).toBe(home.tenant_id)
    expect(result.needsSelection).toBe(true)
  })
})

describe('dedupeTenantContexts', () => {
  it('collapses duplicate memberships for the same tenant id', () => {
    const tenantId = '11111111-1111-4111-8111-111111111111'
    const memberRecord = makeTenant({ tenant_id: tenantId, role: 'member', membership_kind: 'admin' })
    const homeAdminRecord = makeTenant({ tenant_id: tenantId, role: 'admin', membership_kind: 'home' })

    const result = dedupeTenantContexts([memberRecord, homeAdminRecord])
    expect(result).toHaveLength(1)
    expect(result[0]?.tenant_id).toBe(tenantId)
    expect(result[0]?.membership_kind).toBe('home')
    expect(result[0]?.role).toBe('admin')
  })

  it('keeps distinct tenant ids untouched', () => {
    const home = makeTenant({ tenant_id: '11111111-1111-4111-8111-111111111111' })
    const demo = makeTenant({
      tenant_id: '22222222-2222-4222-8222-222222222222',
      slug: 'demo',
      display_name: 'Demo',
      membership_kind: 'temporary_demo',
      is_demo: true,
    })

    const result = dedupeTenantContexts([home, demo])
    expect(result).toHaveLength(2)
  })
})
