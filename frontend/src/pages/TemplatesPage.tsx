import { FormEvent, useEffect, useMemo, useState } from 'react';
import { templatesApi } from '../api/templates';
import type { NotificationTemplateRecord, TemplateChannel } from '../api/templates';
import type { TemplateVersionRecord } from '../api/templates';

interface TemplateFormState {
  template_name: string;
  channel: TemplateChannel;
  subject: string;
  body: string;
  is_active: boolean;
}

const EMPTY_FORM: TemplateFormState = {
  template_name: '',
  channel: 'email',
  subject: '',
  body: '',
  is_active: true,
};

function formFromTemplate(template: NotificationTemplateRecord): TemplateFormState {
  return {
    template_name: template.template_name,
    channel: template.channel,
    subject: template.subject ?? '',
    body: template.body,
    is_active: template.is_active,
  };
}

function TemplatesPage() {
  const [templates, setTemplates] = useState<NotificationTemplateRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState<'all' | TemplateChannel>('all');
  const [showInactive, setShowInactive] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateFormState>(EMPTY_FORM);
  const [historyTemplateId, setHistoryTemplateId] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<TemplateVersionRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [rollbackReason, setRollbackReason] = useState('');
  const [rollbackApproved, setRollbackApproved] = useState(false);
  const [rollbackBusyVersionId, setRollbackBusyVersionId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    templatesApi
      .list({
        channel: channelFilter === 'all' ? undefined : channelFilter,
        is_active: showInactive ? undefined : true,
      })
      .then((rows) => {
        if (!active) {
          return;
        }
        setTemplates(rows);
      })
      .catch((e: unknown) => {
        if (!active) {
          return;
        }
        setError(e instanceof Error ? e.message : 'Failed to load templates.');
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [channelFilter, showInactive]);

  const sortedTemplates = useMemo(
    () => [...templates].sort((a, b) => a.template_name.localeCompare(b.template_name)),
    [templates]
  );

  function resetForm() {
    setEditingTemplateId(null);
    setForm(EMPTY_FORM);
  }

  function startEdit(template: NotificationTemplateRecord) {
    setEditingTemplateId(template.template_id);
    setForm(formFromTemplate(template));
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const nextName = form.template_name.trim();
    const nextBody = form.body.trim();
    const nextSubject = form.subject.trim();

    if (!nextName || !nextBody) {
      setError('Template name and body are required.');
      return;
    }

    if (form.channel === 'email' && !nextSubject) {
      setError('Email templates require a subject.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const payload = {
        template_name: nextName,
        channel: form.channel,
        subject: form.channel === 'email' ? nextSubject : null,
        body: nextBody,
        is_active: form.is_active,
      };

      const updated = editingTemplateId
        ? await templatesApi.update(editingTemplateId, payload)
        : await templatesApi.create(payload);

      setTemplates((current) => {
        const exists = current.some((row) => row.template_id === updated.template_id);
        if (exists) {
          return current.map((row) => (row.template_id === updated.template_id ? updated : row));
        }
        return [updated, ...current];
      });

      resetForm();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save template.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(templateId: string) {
    setError(null);
    try {
      const updated = await templatesApi.deactivate(templateId);
      setTemplates((current) => current.map((row) => (row.template_id === updated.template_id ? updated : row)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to deactivate template.');
    }
  }

  async function handleLoadHistory(templateId: string) {
    setHistoryTemplateId(templateId);
    setHistoryRows([]);
    setHistoryError(null);
    setHistoryLoading(true);
    setRollbackReason('');
    setRollbackApproved(false);
    try {
      const rows = await templatesApi.history(templateId);
      setHistoryRows(rows);
    } catch (e: unknown) {
      setHistoryError(e instanceof Error ? e.message : 'Failed to load template history.');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function handleRollback(templateId: string, versionId: string) {
    if (!rollbackApproved) {
      setHistoryError('Approve rollback before applying a previous version.');
      return;
    }

    setHistoryError(null);
    setRollbackBusyVersionId(versionId);
    try {
      const updated = await templatesApi.rollback(templateId, {
        version_id: versionId,
        approved: true,
        reason: rollbackReason.trim() || undefined,
      });

      setTemplates((current) => current.map((row) => (row.template_id === updated.template_id ? updated : row)));
      await handleLoadHistory(templateId);
    } catch (e: unknown) {
      setHistoryError(e instanceof Error ? e.message : 'Rollback failed.');
    } finally {
      setRollbackBusyVersionId(null);
    }
  }

  return (
    <div className="page">
      <h1 className="page__title">Notification Templates</h1>
      <p className="page__subtitle">Create and maintain reusable email/SMS templates for admin notifications.</p>

      <section className="members-toolbar card" style={{ marginBottom: 12 }}>
        <label className="members-search-label" htmlFor="template-channel-filter">Channel</label>
        <select
          id="template-channel-filter"
          className="members-input"
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value as 'all' | TemplateChannel)}
        >
          <option value="all">All</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
        </select>

        <label className="members-checkbox" style={{ marginLeft: 8 }}>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive templates
        </label>
      </section>

      {error && <p className="members-error">{error}</p>}

      <section className="card" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>{editingTemplateId ? 'Edit template' : 'New template'}</h2>
        <form className="members-form" onSubmit={handleSave}>
          <input
            className="members-input"
            value={form.template_name}
            placeholder="Template name"
            onChange={(e) => setForm((cur) => ({ ...cur, template_name: e.target.value }))}
            required
          />

          <select
            className="members-input"
            value={form.channel}
            onChange={(e) => setForm((cur) => ({ ...cur, channel: e.target.value as TemplateChannel }))}
          >
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>

          {form.channel === 'email' && (
            <input
              className="members-input"
              value={form.subject}
              placeholder="Subject"
              onChange={(e) => setForm((cur) => ({ ...cur, subject: e.target.value }))}
              required
            />
          )}

          <textarea
            className="members-input"
            rows={6}
            value={form.body}
            placeholder="Message body"
            onChange={(e) => setForm((cur) => ({ ...cur, body: e.target.value }))}
            required
          />

          <label className="members-checkbox">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => setForm((cur) => ({ ...cur, is_active: e.target.checked }))}
            />
            Active
          </label>

          <div className="modal__footer" style={{ justifyContent: 'flex-start', padding: 0, borderTop: 'none' }}>
            <button className="btn btn--primary btn--sm" type="submit" disabled={saving}>
              {saving ? 'Saving…' : editingTemplateId ? 'Save template' : 'Create template'}
            </button>
            {editingTemplateId && (
              <button className="btn btn--outline btn--sm" type="button" onClick={resetForm}>
                Cancel edit
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="card members-table-wrap">
        {loading ? (
          <p className="members-loading">Loading templates...</p>
        ) : (
          <table className="members-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedTemplates.length === 0 ? (
                <tr>
                  <td colSpan={5}>No templates found.</td>
                </tr>
              ) : (
                sortedTemplates.map((template) => (
                  <tr key={template.template_id}>
                    <td>{template.template_name}</td>
                    <td>{template.channel}</td>
                    <td>{template.is_active ? 'Active' : 'Inactive'}</td>
                    <td>{new Date(template.updated_at).toLocaleString()}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn--outline btn--sm" onClick={() => startEdit(template)}>
                          Edit
                        </button>
                        <button
                          className="btn btn--outline btn--sm"
                          onClick={() => void handleLoadHistory(template.template_id)}
                        >
                          History
                        </button>
                        {template.is_active && (
                          <button
                            className="btn btn--outline btn--sm"
                            onClick={() => void handleDeactivate(template.template_id)}
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </section>

      {historyTemplateId && (
        <section className="card" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>Template History</h2>
          <p className="page__subtitle" style={{ marginTop: 0 }}>Template ID: {historyTemplateId}</p>

          <textarea
            className="members-input"
            rows={2}
            placeholder="Rollback reason (optional)"
            value={rollbackReason}
            onChange={(e) => setRollbackReason(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <label className="members-checkbox" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={rollbackApproved}
              onChange={(e) => setRollbackApproved(e.target.checked)}
            />
            I reviewed this version and approve rollback.
          </label>

          {historyError && <p className="members-error">{historyError}</p>}

          {historyLoading ? (
            <p className="members-loading">Loading history...</p>
          ) : historyRows.length === 0 ? (
            <p className="members-loading">No history snapshots found yet.</p>
          ) : (
            <table className="members-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>By</th>
                  <th>Reason</th>
                  <th>Rollback</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map((row) => (
                  <tr key={row.version_id}>
                    <td>{new Date(row.created_at).toLocaleString()}</td>
                    <td>{row.action}</td>
                    <td>{row.changed_by ?? 'system'}</td>
                    <td>{row.reason ?? '—'}</td>
                    <td>
                      <button
                        className="btn btn--outline btn--sm"
                        disabled={rollbackBusyVersionId === row.version_id || !rollbackApproved}
                        onClick={() => void handleRollback(historyTemplateId, row.version_id)}
                      >
                        {rollbackBusyVersionId === row.version_id ? 'Applying…' : 'Rollback'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

export { TemplatesPage };
