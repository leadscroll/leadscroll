/**
 * Presentation mapping for the compact test-send state stored inside the
 * installation document.
 */

import { type EmailTestState, type EmailTestView } from '@/domain/schemas';

export const testViewForState = (last: EmailTestState): EmailTestView => ({
  at: new Date(last.at).toISOString(),
  outcome: last.outcome,
  providerMessageId: last.providerMessageId,
  reasonCode: last.reasonCode,
  revision: last.configRevision,
});

export const testView = (last: EmailTestState | null): EmailTestView | null =>
  last === null ? null : testViewForState(last);
