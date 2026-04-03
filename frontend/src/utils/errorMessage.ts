function toUserErrorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  const raw = error.message?.trim();
  if (!raw) {
    return fallback;
  }

  const withoutPrefix = raw.replace(/^API\s\d+:\s*/i, '').trim();
  const normalized = withoutPrefix.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  return normalized.length > 0 ? normalized : fallback;
}

export { toUserErrorMessage };
