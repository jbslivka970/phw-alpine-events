# Template Governance Policy

## Purpose

Define a repeatable approval and audit process for notification template changes, including AI-generated drafts applied through admin tooling.

## Scope

Applies to all records in notification_template and all history snapshots in notification_template_version.

## Required Controls

1. Dual-control approval
- A template change must be reviewed and approved before applying to active templates.
- The reviewer should not be the same person who authored the draft when staffing allows.

2. Recorded rationale
- Every rollback/apply action should include a concise reason note.
- Notes should capture intent, audience impact, and urgency if applicable.

3. Audit traceability
- Use structured events (for example, admin_ai_invite_template_applied) and version snapshots for each update/deactivate/rollback.
- Retain logs per retention policy.

4. Channel safety checks
- Email templates must include a subject and validated body placeholders.
- SMS templates should remain concise and comply with carrier/SMS program requirements.

## Operating Cadence

1. Weekly review
- Review all template changes from the last 7 days.
- Verify reason notes and approver identity are present.

2. Monthly compliance check
- Confirm active templates still align with approved messaging and legal/compliance requirements.
- Spot-check rollback readiness by restoring a non-production template version.

3. Incident rollback playbook
- If a template causes incorrect messaging, rollback to last known-good version immediately.
- Record incident reference in rollback reason.

## Ownership

- Primary owner: Chapter Admin operations lead.
- Backup owner: Platform/engineering maintainer.

## Evidence to retain

- Template history rows (notification_template_version).
- Structured apply/rollback events.
- PR/issue references for major messaging changes.
