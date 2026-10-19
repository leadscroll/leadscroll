/**
 * Minimal, masked lead preview for notification emails.
 *
 * The full surname never leaves this helper: only its first character is
 * returned. Email, phone, custom fields, notes, and raw payloads are
 * deliberately absent, and the result is a single line so it cannot reshape
 * the message.
 */

const MAX_NAME_LENGTH = 40;
const MAX_SOURCE_LENGTH = 64;

const clean = (value: string): string => value.replaceAll(/\s+/gu, ' ').trim();

const firstCharacter = (value: string): string => Array.from(value)[0] ?? '';

const truncate = (value: string, maximum: number): string => {
  const characters = Array.from(value);
  if (characters.length <= maximum) {
    return value;
  }

  return `${characters
    .slice(0, maximum - 1)
    .join('')
    .trimEnd()}…`;
};

export const formatLeadSummary = (lead: {
  firstName: null | string;
  lastName: null | string;
  source: string;
}): string => {
  const firstName = clean(lead.firstName ?? '');
  const lastName = clean(lead.lastName ?? '');
  const lastInitial =
    lastName === '' ? '' : `${firstCharacter(lastName).toLocaleUpperCase()}.`;
  const name = [truncate(firstName, MAX_NAME_LENGTH), lastInitial]
    .filter(Boolean)
    .join(' ');
  const source = truncate(clean(lead.source), MAX_SOURCE_LENGTH);

  return [name, source].filter(Boolean).join(' · ');
};
