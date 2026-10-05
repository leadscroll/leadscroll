import { localZone } from './datetime';

// LeadScroll has no named releases yet, so every instance labels its build with
// the local calendar date it was deployed. The instant is injected by Vite at
// bundle time (see vite.config.ts), mirroring the clew-app convention.
export const releaseLabel = (
  builtAt: string,
  zone: string = localZone(),
): string =>
  `v${Temporal.Instant.from(builtAt).toZonedDateTimeISO(zone).toPlainDate()}`;
