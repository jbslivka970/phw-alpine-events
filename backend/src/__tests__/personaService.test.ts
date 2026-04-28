import { normalizePersona, SUPPORTED_PERSONAS } from '../services/personaService';

describe('personaService.normalizePersona', () => {
  it('accepts every supported persona', () => {
    for (const persona of SUPPORTED_PERSONAS) {
      expect(normalizePersona(persona)).toBe(persona);
      expect(normalizePersona(persona.toUpperCase())).toBe(persona);
      expect(normalizePersona(`  ${persona}  `)).toBe(persona);
    }
  });

  it('rejects unknown values, non-strings, and empty input', () => {
    expect(normalizePersona('admin')).toBeNull();          // role, not persona
    expect(normalizePersona('event_creator')).toBeNull();  // role, not persona
    expect(normalizePersona('')).toBeNull();
    expect(normalizePersona(undefined)).toBeNull();
    expect(normalizePersona(null)).toBeNull();
    expect(normalizePersona(42)).toBeNull();
    expect(normalizePersona({ persona: 'volunteer' })).toBeNull();
  });
});
