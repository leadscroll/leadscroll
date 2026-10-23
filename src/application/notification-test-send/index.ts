/**
 * Explicit administrator test email.
 *
 * One attempt per request id: the reservation is written inside the
 * installation document before any outbound call, the rolling 1/minute and
 * 5/24-hour windows are re-evaluated after every lost compare-and-swap race,
 * and completion reconciles only the caller's own reserved id. There is no
 * automatic retry, replay, or durable attempt table.
 */

export { type SendTestEmailInput } from './attempts';
export { sendTestEmailCommand } from './command';
