import { describe, expect, it } from 'vitest';
import { formatReportRate } from '../ReportsPage';

describe('report rates', () => {
  it('formats fill and attendance rates from their relevant populations', () => {
    expect(formatReportRate(2, 4)).toBe('50%');
    expect(formatReportRate(1, 2)).toBe('50%');
    expect(formatReportRate(0, 0)).toBe('—');
  });
});