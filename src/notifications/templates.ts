/**
 * Fixed notification templates for new-lead alerts and explicit test
 * messages.
 *
 * Content is deliberately generic: no contact fields, custom-field values,
 * raw intake payloads, source text, IPs, tracking pixels, or remote images.
 * Both messages link to the authenticated application only. Dynamic values
 * (canonical origin, lead id) are escaped before interpolation.
 */

import { type EmailEnvelope } from './email';

export const NOTIFICATION_TEMPLATE_VERSION = 1;
export const NOTIFICATION_SUBJECT = 'A new lead is available in LeadScroll';
export const TEST_SUBJECT = 'LeadScroll test email';

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const renderNewLeadNotification = (input: {
  leadId: string;
  origin: string;
}): Pick<EmailEnvelope, 'html' | 'subject' | 'text'> => {
  const leadUrl = `${input.origin}/leads/${encodeURIComponent(input.leadId)}`;
  const preferencesUrl = `${input.origin}/settings/account`;
  const leadUrlHtml = escapeHtml(leadUrl);
  const preferencesUrlHtml = escapeHtml(preferencesUrl);

  return {
    html: [
      '<p>A new lead is available in LeadScroll.</p>',
      `<p><a href="${leadUrlHtml}">Open the lead</a></p>`,
      `<p>You receive this email because new-lead notifications are on in your <a href="${preferencesUrlHtml}">account settings</a>.</p>`,
    ].join('\n'),
    subject: NOTIFICATION_SUBJECT,
    text: [
      'A new lead is available in LeadScroll.',
      '',
      `Open the lead: ${leadUrl}`,
      '',
      `Manage notifications: ${preferencesUrl}`,
    ].join('\n'),
  };
};

export const renderTestEmail = (input: {
  origin: string;
}): Pick<EmailEnvelope, 'html' | 'subject' | 'text'> => {
  const preferencesUrl = `${input.origin}/settings/account`;
  const preferencesUrlHtml = escapeHtml(preferencesUrl);

  return {
    html: [
      '<p>This is a test email from LeadScroll.</p>',
      '<p>New-lead notification email is connected to your provider. If you received this message, sending is configured.</p>',
      `<p>Manage notifications in your <a href="${preferencesUrlHtml}">account settings</a>.</p>`,
    ].join('\n'),
    subject: TEST_SUBJECT,
    text: [
      'This is a test email from LeadScroll.',
      '',
      'New-lead notification email is connected to your provider. If you received this message, sending is configured.',
      '',
      `Manage notifications: ${preferencesUrl}`,
    ].join('\n'),
  };
};
