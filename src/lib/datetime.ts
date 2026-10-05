// Wall-clock helpers for datetime-local inputs.
//
// Temporal models the three planes explicitly: `PlainDateTime` is the civil
// value a `datetime-local` input carries, `ZonedDateTime` attaches the IANA
// zone, and `Instant` is the universal moment the API stores. The polyfill is
// loaded at boot only where the runtime lacks native Temporal (see main.tsx).

const WALL_CLOCK = { smallestUnit: 'minute' } as const;
const MILLISECONDS = { fractionalSecondDigits: 3 } as const;

export const localZone = (): string => Temporal.Now.timeZoneId();

// The input value is local wall-clock time. An empty input means "use the
// server default" and maps to undefined; so do malformed values. Conversion
// uses the platform-compatible DST resolution (gap -> later, overlap ->
// earlier); `wallClockIssue` rejects gap values before a form can submit one.
export const wallClockToIso = (
  value: string,
  zone: string,
): string | undefined => {
  if (value === '') {
    return undefined;
  }

  try {
    return Temporal.PlainDateTime.from(value)
      .toZonedDateTime(zone, { disambiguation: 'compatible' })
      .toInstant()
      .toString(MILLISECONDS);
  } catch {
    return undefined;
  }
};

export const localDateTimeToIso = (value: string): string | undefined =>
  wallClockToIso(value, localZone());

// `datetime-local` rendering of an instant in the given zone.
export const toLocalInputValue = (date: Date, zone = localZone()): string =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString(WALL_CLOCK);

// Form validation: returns the message to show, or true when the wall clock is
// a usable future instant. An empty input means "server default" and is valid.
export const wallClockIssue = (
  value: string,
  zone = localZone(),
): string | true => {
  if (value === '') {
    return true;
  }

  try {
    const wall = Temporal.PlainDateTime.from(value);
    // 'compatible' never throws; the round-trip below detects the DST gap.
    const zoned = wall.toZonedDateTime(zone, { disambiguation: 'compatible' });

    if (!zoned.toPlainDateTime().equals(wall)) {
      return 'That local time does not exist on this date (daylight saving).';
    }

    return Temporal.Instant.compare(zoned.toInstant(), Temporal.Now.instant()) >
      0
      ? true
      : 'Expiration must be in the future.';
  } catch {
    return 'Expiration must be in the future.';
  }
};

// The zone label for the selected value; an empty or invalid value falls back
// to the current offset.
export const localTimezoneLabel = (
  value: string,
  zone = localZone(),
): string => {
  let offset = Temporal.Now.instant().toZonedDateTimeISO(zone).offset;

  try {
    offset = Temporal.PlainDateTime.from(value).toZonedDateTime(zone, {
      disambiguation: 'compatible',
    }).offset;
  } catch {
    // Keep the current offset.
  }

  return `${zone} (UTC${offset})`;
};
