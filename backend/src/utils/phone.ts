function toE164(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }

  const raw = input.trim();
  if (!raw) {
    return null;
  }

  const digitsOnly = raw.replace(/\D/g, '');

  if (raw.startsWith('+') && digitsOnly.length >= 8 && digitsOnly.length <= 15) {
    return `+${digitsOnly}`;
  }

  if (digitsOnly.length === 10) {
    return `+1${digitsOnly}`;
  }

  if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    return `+${digitsOnly}`;
  }

  return null;
}

export { toE164 };