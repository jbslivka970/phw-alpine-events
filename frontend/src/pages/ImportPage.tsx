import { useEffect, useRef, useState } from 'react'
import { importApi } from '../api/imports'
import type { ImportCommitResult, ImportPreviewResult } from '../api/imports'

interface ImportLogEntry {
  import_id: string
  file_name: string
  imported_at: string
  total_rows: number
  new_rows: number
  updated_rows: number
  skipped_rows: number
  error_rows: number
  imported_by: string | null
}

type Phase = 'idle' | 'previewing' | 'preview' | 'committing' | 'done' | 'error'

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
  const [logs, setLogs] = useState<ImportLogEntry[]>([])
  const [logsLoading, setLogsLoading] = useState(false)

  async function loadLogs() {
    setLogsLoading(true)
    try {
      const data = await importApi.logs()
      setLogs((data.logs ?? []) as ImportLogEntry[])
    } catch {
      // non-fatal — just leave logs empty
    } finally {
      setLogsLoading(false)
    }
  }

  useEffect(() => {
    void loadLogs()
  }, [])

  function resetToIdle() {
    setPhase('idle')
    setPreview(null)
    setResult(null)
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
      const data = await importApi.commit(preview.sessionId)
      setResult(data)
      setPhase('done')
      void loadLogs()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.')
      setPhase('error')
    }
  }

  return (
    <div className="import-page">
      <div className="import-page__header">
        <h1 className="page-title">CSV Import</h1>
        <p className="page-subtitle">Upload a member CSV to preview changes before committing.</p>
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
              <SummaryRow label="Skipped" value={preview.summary.skippedRows} />
              <SummaryRow label="Errors" value={preview.summary.errorRows} />
            </div>

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
          <button className="btn btn--outline btn--sm" onClick={loadLogs} disabled={logsLoading}>
            {logsLoading ? 'Loading…' : 'Refresh'}
          </button>
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
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.import_id}>
                    <td className="import-logs__file">{log.file_name}</td>
                    <td>{new Date(log.imported_at).toLocaleString()}</td>
                    <td>{log.total_rows}</td>
                    <td>{log.new_rows}</td>
                    <td>{log.updated_rows}</td>
                    <td className={log.error_rows > 0 ? 'import-logs__errors--nonzero' : ''}>
                      {log.error_rows}
                    </td>
                    <td>{log.imported_by ?? '—'}</td>
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
