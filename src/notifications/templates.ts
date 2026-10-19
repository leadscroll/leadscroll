/**
 * Fixed notification templates for new-lead alerts and explicit test
 * messages.
 *
 * The MJML sources in `emails/` are compiled to static HTML by
 * `pnpm emails:build`. The Worker only substitutes the authenticated URLs at
 * send time, so the MJML compiler and React never ship in the runtime bundle.
 * The new-lead alert carries only a masked preview (first name, last-name
 * initial, source). Email, phone, full surname, custom-field values, raw
 * intake payloads, notes, IPs, tracking pixels, and remote images are
 * deliberately absent.
 */

import { type EmailEnvelope } from './email';
import generated from './emails/templates.generated.json';

export const NOTIFICATION_TEMPLATE_VERSION = 3;
export const NOTIFICATION_SUBJECT = 'New lead in LeadScroll';
export const TEST_SUBJECT = 'LeadScroll test email';

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const fillTemplate = (
  template: string,
  values: Record<string, string>,
): string => {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${key}}}`, escapeHtml(value));
  }

  return output;
};

export const renderNewLeadNotification = (input: {
  leadId: string;
  leadSummary: string;
  origin: string;
}): Pick<EmailEnvelope, 'html' | 'subject' | 'text'> => {
  const leadUrl = `${input.origin}/leads/${encodeURIComponent(input.leadId)}`;
  const preferencesUrl = `${input.origin}/settings/account`;

  const summary = input.leadSummary.trim();

  return {
    html: fillTemplate(generated.newLead, {
      LEAD_SUMMARY: summary,
      LEAD_URL: leadUrl,
      PREFERENCES_URL: preferencesUrl,
    }),
    subject: NOTIFICATION_SUBJECT,
    text: [
      'A new lead is available in LeadScroll.',
      '',
      ...(summary === '' ? [] : [summary, '']),
      `Open the lead: ${leadUrl}`,
      '',
      'You receive this because new-lead emails are on for your account.',
      `Manage notifications: ${preferencesUrl}`,
    ].join('\n'),
  };
};

export const renderTestEmail = (input: {
  origin: string;
}): Pick<EmailEnvelope, 'html' | 'subject' | 'text'> => {
  const settingsUrl = `${input.origin}/settings/email`;

  return {
    html: fillTemplate(generated.test, { SETTINGS_URL: settingsUrl }),
    subject: TEST_SUBJECT,
    text: [
      'LeadScroll test email',
      '',
      'Email is working. This test email was sent to your account address.',
      'New-lead alerts will use the same sender and provider.',
      '',
      `Open email settings: ${settingsUrl}`,
      '',
      'This test was requested from Manage → Email. It does not include lead data.',
    ].join('\n'),
  };
};
