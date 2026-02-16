export function stripQueryString(url: string): string {
  const querySeparatorIndex = url.indexOf('?');
  if (querySeparatorIndex === -1) {
    return url;
  }
  return url.slice(0, querySeparatorIndex);
}

export function normalizeOrigin(rawOrigin: string): string | null {
  try {
    const parsed = new URL(rawOrigin.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function normalizeContentType(contentType: string): string {
  return contentType.trim().toLowerCase();
}
