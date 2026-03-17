/**
 * Normalise a phone number to E.164 format (+1XXXXXXXXXX for US numbers).
 * Returns null when the input cannot be converted to a valid E.164 number.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Strip everything except digits and leading +
  const stripped = raw.replace(/[^\d+]/g, '');

  // If it already starts with + treat it as international
  if (stripped.startsWith('+')) {
    // Must be + followed by 7–15 digits
    if (/^\+\d{7,15}$/.test(stripped)) {
      return stripped;
    }
    return null;
  }

  const digits = stripped.replace(/\D/g, '');

  // 10-digit US number – prepend +1
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  // 11-digit number starting with 1 – prepend +
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  // Other lengths that are valid E.164 digit counts (7–15)
  if (digits.length >= 7 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}
