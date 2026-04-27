import { useEffect, useRef, useState } from 'react'
import { importApi } from '../api/imports'
import type { AbsentMember, ImportCommitResult, ImportLog, ImportPreviewResult, ImportPreviewRow } from '../api/imports'
import { membersApi } from '../api/members'

type Phase = 'idle' | 'previewing' | 'preview' | 'committing' | 'done' | 'error'

type ConflictResolution = 'create' | 'skip'

function isConflictRow(row: ImportPreviewRow): row is ImportPreviewRow & { action: 'conflict' } {
  return row.action === 'conflict'
}

function SummaryRow({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`import-summary__row${highlight ? ' import-summary__row--highlight' : ''}`}>
      <span className="import-summary__label">{label}</span>
      <span className="import-summary__value">{value.toLocaleString()}</span>
    </div>
  )
}

function ImportPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null)
  const [result, setResult] = useState<ImportCommitResult | null>(null)
  const [conflictResolutions, setConflictResolutions] = useState<Record<number, ConflictResolution>>({})
  const [logs, setLogs] = useState<ImportLog[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [filters, setFilters] = useState({
    startedFrom: '',
    startedTo: '',
    importedBy: '',
  })

  async function loadLogs(activeFilters = filters) {
    setLogsLoading(true)
    try {
      const data = await importApi.logs({
        startedFrom: activeFilters.startedFrom || undefined,
        startedTo: activeFilters.startedTo || undefined,
        importedBy: activeFilters.importedBy || undefined,
      })
      setLogs(data.logs ?? [])
    } catch {
      // non-fatal — just leave logs empty
    } finally {
      setLogsLoading(false)
    }
  }

  useEffect(() => {
    void loadLogs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function resetToIdle() {
    setPhase('idle')
    setPreview(null)
    setResult(null)
    setConflictResolutions({})
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Only CSV files are accepted.')
      return
    }
    setError(null)
    setPhase('previewing')
    try {
      const data = await importApi.preview(file)
      setPreview(data)
      const defaults: Record<number, ConflictResolution> = {}
      for (const row of data.rows) {
        if (isConflictRow(row)) {
          defaults[row.rowNumber] = 'skip'
        }
      }
      setConflictResolutions(defaults)
      setPhase('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed.')
      setPhase('error')
    }
  }

  async function handleCommit() {
    if (!preview) return
    setPhase('committing')
    setError(null)
    try {
      const data = await importApi.commit(preview.sessionId, {
        conflictResolutions: Object.fromEntries(
          Object.entries(conflictResolutions).map(([rowNumber, resolution]) => [rowNumber, resolution])
        ),
      })
      setResult(data)
      setPhase('done')
      void loadLogs()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.')
      setPhase('error')
    }
  }

  function updateConflictResolution(rowNumber: number, resolution: ConflictResolution) {
    setConflictResolutions((current) => ({
      ...current,
      [rowNumber]: resolution,
    }))
  }

  async function handleDownloadReport(importId: string) {
    try {
      await importApi.downloadReport(importId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download import report.')
    }
  }

  function handleApplyFilters() {
    void loadLogs(filters)
  }

  function handleClearFilters() {
    const empty = { startedFrom: '', startedTo: '', importedBy: '' }
    setFilters(empty)
    void loadLogs(empty)
  }

  const conflictRows = (preview?.rows ?? []).filter(isConflictRow)
  const [absentDismissed, setAbsentDismissed] = useState<Set<string>>(new Set())
  const [absentActionError, setAbsentActionError] = useState<string | null>(null)

  async function handleAbsentDeactivate(member: AbsentMember) {
    if (!window.confirm(`Deactivate ${member.first_name} ${member.last_name}? They will be hidden from active lists but their data is preserved.`)) return
    try {
      await membersApi.remove(member.member_id)
      setAbsentDismissed((prev) => new Set([...prev, member.member_id]))
    } catch (err) {
      setAbsentActionError(err instanceof Error ? err.message : 'Deactivate failed.')
    }
  }

  async function handleAbsentHardDelete(member: AbsentMember) {
    const fullName = `${member.first_name} ${member.last_name}`
    const confirmed = window.prompt(`PERMANENT DELETE — cannot be undone.\n\nType "${fullName}" to confirm.`)
    if (confirmed === null) return
    if (confirmed.trim() !== fullName.trim()) {
      setAbsentActionError('Name did not match. Delete cancelled.')
      return
    }
    try {
      await membersApi.hardDelete(member.member_id)
      setAbsentDismissed((prev) => new Set([...prev, member.member_id]))
    } catch (err) {
      setAbsentActionError(err instanceof Error ? err.message : 'Delete failed.')
    }
  }

  const visibleAbsentMembers = (preview?.absentMembers ?? []).filter(
    (m) => !absentDismissed.has(m.member_id)
  )

  return (
    <div className="import-page">
      <div className="import-page__header">
        <h1 className="page-title">CSV Import</h1>
        <p className="page-subtitle">Upload a member CSV to preview changes before committing. Optional columns active volunteer and active participant map members into Volunteer/Participant groups.</p>
      </div>

      {/* Upload card */}
      <section className="import-card">
        <h2 className="import-card__title">Upload File</h2>

        {phase === 'idle' || phase === 'error' ? (
          <label className="import-dropzone">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="import-dropzone__input"
              onChange={handleFileChange}
            />
            <span className="import-dropzone__icon">📄</span>
            <span className="import-dropzone__text">Click to select a CSV file</span>
            <span className="import-dropzone__hint">.csv only — max 10 MB</span>
          </label>
        ) : null}

        {phase === 'previewing' && (
          <p className="import-status">Generating preview…</p>
        )}

        {error && <p className="import-error">{error}</p>}

        {/* Preview summary */}
        {(phase === 'preview' || phase === 'committing') && preview && (
          <div className="import-preview">
            <p className="import-preview__file">
              <strong>{preview.fileName}</strong>
            </p>
            <div className="import-summary">
              <SummaryRow label="Total rows" value={preview.summary.totalRows} />
              <SummaryRow label="New members" value={preview.summary.newRows} highlight />
              <SummaryRow label="Updated members" value={preview.summary.updatedRows} highlight />
              <SummaryRow label="Unchanged" value={preview.summary.unchangedRows ?? 0} />
              <SummaryRow label="Conflicts" value={preview.summary.conflictRows ?? 0} />
              <SummaryRow label="Skipped" value={preview.summary.skippedRows} />
              <SummaryRow label="Errors" value={preview.summary.errorRows} />
            </div>

            {conflictRows.length > 0 && (
              <div className="import-conflicts">
                <h3 className="import-conflicts__title">Shared Email Conflicts</h3>
                <p className="import-conflicts__hint">
                  Choose how to handle each row where the email already exists for a different member name.
                </p>
                <div className="import-conflicts__table-wrapper">
                  <table className="import-conflicts__table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Incoming Member</th>
                        <th>Email</th>
                        <th>Existing Members</th>
                        <th>Decision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conflictRows.map((row) => (
                        <tr key={row.rowNumber}>
                          <td>{row.rowNumber}</td>
                          <td>{`${row.data.firstName} ${row.data.lastName}`.trim()}</td>
                          <td>{row.data.email}</td>
                          <td>
                            {(row.conflictMembers ?? []).length === 0
                              ? row.errorMessage ?? 'Conflict detected'
                              : (row.conflictMembers ?? [])
                                  .map((member) => `${member.firstName} ${member.lastName}`.trim())
                                  .join(', ')}
                          </td>
                          <td>
                            <select
                              className="import-conflicts__select"
                              value={conflictResolutions[row.rowNumber] ?? 'skip'}
                              onChange={(event) =>
                                updateConflictResolution(row.rowNumber, event.target.value as ConflictResolution)
                              }
                            >
                              <option value="skip">Skip</option>
                              <option value="create">Create New Member</option>
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {visibleAbsentMembers.length > 0 && (
              <div className="import-conflicts" style={{ marginTop: 16 }}>
                <h3 className="import-conflicts__title">Members Not in This CSV ({visibleAbsentMembers.length})</h3>
                <p className="import-conflicts__hint">
                  These active members are not present in the uploaded file. Salesforce is the source of truth — review and deactivate or delete as needed.
                </p>
                {absentActionError && <p className="import-error">{absentActionError}</p>}
                <div className="import-conflicts__table-wrapper">
                  <table className="import-conflicts__table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleAbsentMembers.map((member) => (
                        <tr key={member.member_id}>
                          <td>{member.first_name} {member.last_name}</td>
                          <td>{member.email}</td>
                          <td>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                className="btn btn--sm btn--outline"
                                type="button"
                                onClick={() => void handleAbsentDeactivate(member)}
                              >
                                Deactivate
                              </button>
                              <button
                                className="btn btn--sm"
                                type="button"
                                style={{ background: '#b91c1c', borderColor: '#b91c1c', color: '#fff' }}
                                onClick={() => void handleAbsentHardDelete(member)}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="import-preview__actions">
              <button
                className="btn btn--primary"
                onClick={handleCommit}
                disabled={phase === 'committing'}
              >
                {phase === 'committing' ? 'Importing…' : 'Confirm Import'}
              </button>
              <button
                className="btn btn--outline"
                onClick={resetToIdle}
                disabled={phase === 'committing'}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Done state */}
        {phase === 'done' && result && (
          <div className="import-result">
            <p className="import-result__success">Import complete!</p>
            <div className="import-summary">
              <SummaryRow label="New members added" value={result.summary.newRows} highlight />
              <SummaryRow label="Members updated" value={result.summary.updatedRows} highlight />
              <SummaryRow label="Conflicts reviewed" value={result.summary.conflictRows ?? 0} />
              <SummaryRow label="Skipped" value={result.summary.skippedRows} />
              <SummaryRow label="Errors" value={result.summary.errorRows} />
            </div>
            <button className="btn btn--outline" onClick={resetToIdle}>
              Import another file
            </button>
          </div>
        )}
      </section>

      {/* Import history */}
      <section className="import-card">
        <div className="import-logs__header">
          <h2 className="import-card__title">Import History</h2>
          <button className="btn btn--outline btn--sm" onClick={() => void loadLogs()} disabled={logsLoading}>
            {logsLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        <p className="import-logs__hint">Use the Download button in the right-most column to export a CSV report for any import run.</p>

        <div className="import-logs__filters">
          <label className="import-logs__filter">
            <span>From</span>
            <input
              type="date"
              value={filters.startedFrom}
              onChange={(event) => setFilters((current) => ({ ...current, startedFrom: event.target.value }))}
            />
          </label>
          <label className="import-logs__filter">
            <span>To</span>
            <input
              type="date"
              value={filters.startedTo}
              onChange={(event) => setFilters((current) => ({ ...current, startedTo: event.target.value }))}
            />
          </label>
          <label className="import-logs__filter import-logs__filter--wide">
            <span>Operator</span>
            <input
              type="text"
              placeholder="Email or user ID"
              value={filters.importedBy}
              onChange={(event) => setFilters((current) => ({ ...current, importedBy: event.target.value }))}
            />
          </label>
          <div className="import-logs__filter-actions">
            <button className="btn btn--outline btn--sm" onClick={handleApplyFilters} disabled={logsLoading}>
              Apply
            </button>
            <button className="btn btn--outline btn--sm" onClick={handleClearFilters} disabled={logsLoading}>
              Clear
            </button>
          </div>
        </div>

        {logsLoading && logs.length === 0 ? (
          <p className="import-status">Loading history…</p>
        ) : logs.length === 0 ? (
          <p className="import-empty">No imports yet.</p>
        ) : (
          <div className="import-logs__table-wrapper">
            <table className="import-logs__table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Date</th>
                  <th>Total</th>
                  <th>New</th>
                  <th>Updated</th>
                  <th>Errors</th>
                  <th>Imported By</th>
                  <th>Download</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.importId}>
                    <td className="import-logs__file">{log.fileName ?? '—'}</td>
                    <td>{new Date(log.startedAt).toLocaleString()}</td>
                    <td>{log.rowsProcessed}</td>
                    <td>{log.rowsInserted}</td>
                    <td>{log.rowsUpdated}</td>
                    <td className={log.rowsErrored > 0 ? 'import-logs__errors--nonzero' : ''}>
                      {log.rowsErrored}
                    </td>
                    <td>{log.importedBy ?? '—'}</td>
                    <td>
                      <button
                        className="btn btn--outline btn--sm"
                        onClick={() => void handleDownloadReport(log.importId)}
                      >
                        Download CSV
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

export { ImportPage }
