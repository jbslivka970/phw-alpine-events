#!/usr/bin/env node

/**
 * Reminder duplication evidence smoke checks.
 *
 * This script validates admin report access for reminder duplicate analysis.
 * It is non-destructive and requires an admin token.
 *
 * Environment variables:
 * - BACKEND_BASE_URL: API origin, example https://phwalpineeventsjb873a.azurewebsites.net
 * - REMINDER_ADMIN_BEARER_TOKEN: admin JWT required for report access
 * - REMINDER_REPORT_DAYS: optional lookback window (default 30)
 * - REMINDER_EXPECT_NO_DUPLICATES: set to 1 to fail if duplicate_count > 0
 */

const backendBaseUrl = (process.env.BACKEND_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const adminBearerToken = process.env.REMINDER_ADMIN_BEARER_TOKEN || '';
const reportDays = Number.parseInt(process.env.REMINDER_REPORT_DAYS || '30', 10);
const enforceNoDuplicates = process.env.REMINDER_EXPECT_NO_DUPLICATES === '1';

function url(path) {
  return `${backendBaseUrl}${path}`;
}

async function getJson(path, headers = {}) {
  const response = await fetch(url(path), {
    method: 'GET',
    headers,
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = { raw: await response.text() };
  }

  return { status: response.status, body };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

(async () => {
  const allChecks = [];

  try {
    allChecks.push(['backend_base_url', backendBaseUrl]);
    allChecks.push(['report_days', Number.isFinite(reportDays) && reportDays > 0 ? reportDays : 30]);
    allChecks.push(['enforce_no_duplicates', enforceNoDuplicates]);

    if (!adminBearerToken) {
      allChecks.push(['skipped', 'missing REMINDER_ADMIN_BEARER_TOKEN']);
      allChecks.push(['result', 'PASS']);
      for (const [key, value] of allChecks) {
        console.log(`${key}=${value}`);
      }
      return;
    }

    const days = Number.isFinite(reportDays) && reportDays > 0 ? reportDays : 30;
    const query = `/api/v1/reports/reminders?from=${encodeURIComponent(new Date(Date.now() - days * 86400000).toISOString().slice(0, 10))}`;
    const report = await getJson(query, {
      Authorization: `Bearer ${adminBearerToken}`,
    });

    allChecks.push(['reminder_report_status', report.status]);
    allChecks.push(['reminder_report_body', JSON.stringify(report.body)]);
    assert(report.status === 200, 'Reminder duplicate report should return 200 for admin token.');

    const duplicateCount = Number(report.body?.duplicate_count ?? 0);
    allChecks.push(['reminder_duplicate_count', duplicateCount]);

    if (enforceNoDuplicates) {
      assert(duplicateCount === 0, 'Expected no duplicate reminders but duplicate_count > 0.');
    }

    allChecks.push(['result', 'PASS']);
    for (const [key, value] of allChecks) {
      console.log(`${key}=${value}`);
    }
  } catch (error) {
    allChecks.push(['result', 'FAIL']);
    for (const [key, value] of allChecks) {
      console.log(`${key}=${value}`);
    }
    console.error(`error=${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
})();
