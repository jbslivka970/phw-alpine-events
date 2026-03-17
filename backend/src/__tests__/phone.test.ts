import { toE164 } from '../utils/phone';

describe('toE164', () => {
  it('returns null for falsy input', () => {
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164('')).toBeNull();
  });

  it('normalises a 10-digit US number', () => {
    expect(toE164('3035551234')).toBe('+13035551234');
  });

  it('normalises a formatted US number', () => {
    expect(toE164('(303) 555-1234')).toBe('+13035551234');
    expect(toE164('303-555-1234')).toBe('+13035551234');
    expect(toE164('303.555.1234')).toBe('+13035551234');
  });

  it('normalises an 11-digit US number starting with 1', () => {
    expect(toE164('13035551234')).toBe('+13035551234');
    expect(toE164('+13035551234')).toBe('+13035551234');
  });

  it('passes through an already-formatted international number', () => {
    expect(toE164('+447911123456')).toBe('+447911123456');
  });

  it('returns null for invalid input', () => {
    expect(toE164('123')).toBeNull(); // too short
    expect(toE164('abc')).toBeNull();
  });
});
