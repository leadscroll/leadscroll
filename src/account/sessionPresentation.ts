export const formatTimestamp = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
};

export const describeAgent = (userAgent: null | string): string => {
  if (!userAgent) {
    return 'Unknown device';
  }

  const browser = /Edg\//u.test(userAgent)
    ? 'Edge'
    : /OPR\//u.test(userAgent)
      ? 'Opera'
      : /Firefox\//u.test(userAgent)
        ? 'Firefox'
        : /Chrome\//u.test(userAgent)
          ? 'Chrome'
          : /Safari\//u.test(userAgent)
            ? 'Safari'
            : 'Unknown browser';

  const platform = /iPhone|iPad/u.test(userAgent)
    ? 'iOS'
    : /Android/u.test(userAgent)
      ? 'Android'
      : /Windows/u.test(userAgent)
        ? 'Windows'
        : /Mac OS X/u.test(userAgent)
          ? 'macOS'
          : /Linux/u.test(userAgent)
            ? 'Linux'
            : 'unknown platform';

  return `${browser} on ${platform}`;
};
