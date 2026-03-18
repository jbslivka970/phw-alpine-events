import { FormEvent, Fragment, useEffect, useMemo, useState } from 'react'
import { groupsApi } from '../api/groups'
import type { GroupRecord } from '../api/groups'
import { membersApi } from '../api/members'
import type { MemberRecord } from '../api/members'

function GroupsPage() {
  const [groups, setGroups] = useState<GroupRecord[]>([])
  const [allMembers, setAllMembers] = useState<MemberRecord[]>([])
  const [groupMemberIds, setGroupMemberIds] = useState<Record<string, string[]>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [addMemberId, setAddMemberId] = useState<Record<string, string>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const memberById = useMemo(
    () => Object.fromEntries(allMembers.map((m) => [m.member_id, m])),
    [allMembers],
  )

  useEffect(() => {
    let active = true
    setIsLoading(true)
    Promise.all([
      groupsApi.list(),
      membersApi.list({ page: 1, pageSize: 500, isActive: true }),
    ])
      .then(([grps, memRes]) => {
        if (!active) return
        setGroups(grps)
        setAllMembers(memRes.data)
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load')
      })
      .finally(() => { if (active) setIsLoading(false) })
    return () => { active = false }
  }, [])

  async function loadGroupMembers(groupId: string) {
    try {
      const ids = await groupsApi.members(groupId)
      setGroupMemberIds((cur) => ({ ...cur, [groupId]: ids }))
    } catch {
      setGroupMemberIds((cur) => ({ ...cur, [groupId]: [] }))
    }
  }

  function toggleExpand(groupId: string) {
    if (expandedId === groupId) {
      setExpandedId(null)
    } else {
      setExpandedId(groupId)
      if (groupMemberIds[groupId] === undefined) {
        void loadGroupMembers(groupId)
      }
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setIsSaving(true)
    setError(null)
    try {
      const created = await groupsApi.create({
        group_name: createName.trim(),
        description: createDesc.trim() || null,
      })
      setGroups((cur) => [...cur, created])
      setCreateName('')
      setCreateDesc('')
      setShowCreate(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setIsSaving(false)
    }
  }

  function startEdit(g: GroupRecord) {
    setEditId(g.group_id)
    setEditName(g.group_name)
    setEditDesc(g.description ?? '')
    setDeleteId(null)
  }

  async function handleEdit(e: FormEvent) {
    e.preventDefault()
    if (!editId) return
    setIsSaving(true)
    setError(null)
    try {
      const updated = await groupsApi.update(editId, {
        group_name: editName.trim(),
        description: editDesc.trim() || null,
      })
      setGroups((cur) => cur.map((g) => (g.group_id === editId ? updated : g)))
      setEditId(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete(groupId: string) {
    setIsSaving(true)
    setError(null)
    try {
      await groupsApi.remove(groupId)
      setGroups((cur) => cur.filter((g) => g.group_id !== groupId))
      setDeleteId(null)
      if (expandedId === groupId) setExpandedId(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleAddMember(groupId: string) {
    const memberId = addMemberId[groupId] ?? ''
    if (!memberId) return
    setIsSaving(true)
    try {
      await groupsApi.addMember(groupId, memberId)
      setGroupMemberIds((cur) => ({
        ...cur,
        [groupId]: [...(cur[groupId] ?? []), memberId],
      }))
      setAddMemberId((cur) => ({ ...cur, [groupId]: '' }))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Add member failed')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleRemoveMember(groupId: string, memberId: string) {
    try {
      await groupsApi.removeMember(groupId, memberId)
      setGroupMemberIds((cur) => ({
        ...cur,
        [groupId]: (cur[groupId] ?? []).filter((id) => id !== memberId),
      }))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Remove member failed')
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Groups</h1>
          <p className="page-subtitle">Manage notification groups and member assignments.</p>
        </div>
        <div className="header-actions">
          <button
            className="btn btn--primary btn--sm"
            onClick={() => { setShowCreate((s) => !s); setError(null) }}
          >
            {showCreate ? 'Cancel' : '+ New Group'}
          </button>
        </div>
      </div>

      {showCreate && (
        <section className="card groups-create-card">
          <h2 className="groups-form-title">New Group</h2>
          <form className="groups-form" onSubmit={handleCreate}>
            <div className="form-field">
              <label className="form-label" htmlFor="create-name">Group name</label>
              <input
                id="create-name"
                className="form-input"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. Colorado Front Range"
                required
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="create-desc">Description (optional)</label>
              <input
                id="create-desc"
                className="form-input"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="Short description"
              />
            </div>
            <div className="groups-form-actions">
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={isSaving || !createName.trim()}
              >
                {isSaving ? 'Creating…' : 'Create group'}
              </button>
            </div>
          </form>
        </section>
      )}

      {error && <p className="members-error">{error}</p>}

      <section className="card groups-list-wrap">
        {isLoading ? (
          <p className="members-loading">Loading groups…</p>
        ) : groups.length === 0 ? (
          <p className="empty-state">No groups yet. Create one above.</p>
        ) : (
          <table className="members-table groups-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Description</th>
                <th>Type</th>
                <th>Members</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.group_id}>
                  <tr className={expandedId === g.group_id ? 'groups-row--expanded' : ''}>
                    {editId === g.group_id ? (
                      <td colSpan={4}>
                        <form className="groups-inline-form" onSubmit={handleEdit}>
                          <input
                            className="form-input"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            required
                            autoFocus
                          />
                          <input
                            className="form-input"
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            placeholder="Description"
                          />
                          <button type="submit" className="btn btn--primary btn--sm" disabled={isSaving}>
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn btn--outline btn--sm"
                            onClick={() => setEditId(null)}
                          >
                            Cancel
                          </button>
                        </form>
                      </td>
                    ) : (
                      <>
                        <td className="groups-name">{g.group_name}</td>
                        <td className="groups-desc">{g.description ?? '—'}</td>
                        <td>
                          {g.is_system ? (
                            <span className="status-badge status-badge--draft">system</span>
                          ) : (
                            <span className="status-badge status-badge--published">custom</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn btn--ghost btn--sm"
                            onClick={() => toggleExpand(g.group_id)}
                          >
                            {expandedId === g.group_id
                              ? '▲ hide'
                              : `▼ ${groupMemberIds[g.group_id] !== undefined ? groupMemberIds[g.group_id].length : '…'} members`}
                          </button>
                        </td>
                      </>
                    )}
                    <td>
                      {!g.is_system && editId !== g.group_id && (
                        <div className="groups-actions">
                          <button
                            className="btn btn--outline-dark btn--sm"
                            onClick={() => startEdit(g)}
                          >
                            Edit
                          </button>
                          {deleteId === g.group_id ? (
                            <>
                              <button
                                className="btn btn--sm groups-delete-confirm"
                                onClick={() => handleDelete(g.group_id)}
                                disabled={isSaving}
                              >
                                Confirm
                              </button>
                              <button
                                className="btn btn--ghost btn--sm"
                                onClick={() => setDeleteId(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn btn--ghost btn--sm"
                              onClick={() => setDeleteId(g.group_id)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {expandedId === g.group_id && (
                    <tr className="groups-member-row">
                      <td colSpan={5}>
                        <div className="groups-member-panel">
                          <div className="groups-member-list">
                            {groupMemberIds[g.group_id] === undefined ? (
                              <p className="members-loading">Loading members…</p>
                            ) : groupMemberIds[g.group_id].length === 0 ? (
                              <p className="groups-empty-members">No members in this group yet.</p>
                            ) : (
                              groupMemberIds[g.group_id].map((mid) => {
                                const m = memberById[mid]
                                return (
                                  <div key={mid} className="groups-member-chip">
                                    <span>
                                      {m
                                        ? `${m.first_name} ${m.last_name}`
                                        : mid}
                                    </span>
                                    {m && (
                                      <span className="groups-member-email">{m.email}</span>
                                    )}
                                    <button
                                      className="btn btn--ghost btn--sm groups-remove-btn"
                                      onClick={() => handleRemoveMember(g.group_id, mid)}
                                      title="Remove from group"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                )
                              })
                            )}
                          </div>

                          <div className="groups-add-member">
                            <select
                              className="form-input groups-member-select"
                              value={addMemberId[g.group_id] ?? ''}
                              onChange={(e) =>
                                setAddMemberId((cur) => ({ ...cur, [g.group_id]: e.target.value }))
                              }
                            >
                              <option value="">— Add a member —</option>
                              {allMembers
                                .filter((m) => !(groupMemberIds[g.group_id] ?? []).includes(m.member_id))
                                .map((m) => (
                                  <option key={m.member_id} value={m.member_id}>
                                    {m.first_name} {m.last_name} ({m.email})
                                  </option>
                                ))}
                            </select>
                            <button
                              className="btn btn--primary btn--sm"
                              onClick={() => handleAddMember(g.group_id)}
                              disabled={!addMemberId[g.group_id] || isSaving}
                            >
                              Add
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

export { GroupsPage }
