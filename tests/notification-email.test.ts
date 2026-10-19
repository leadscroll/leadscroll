import { leadDeliveryKey, testDeliveryKeyFor } from '@/notifications/email';
import {
  NOTIFICATION_SUBJECT,
  renderNewLeadNotification,
  renderTestEmail,
  TEST_SUBJECT,
} from '@/notifications/templates';
import { describe, expect, test } from 'vitest';

describe('delivery keys', () => {
  test('namespaces event/recipient and test keys', () => {
    expect(leadDeliveryKey('lead-1', 'user-1')).toBe(
      'leadscroll-notification:lead-1:user-1',
    );
    expect(testDeliveryKeyFor('abc')).toBe('leadscroll-email-test:abc');
  });
});

describe('fixed templates', () => {
  test('renders a generic new-lead message with canonical links only', () => {
    const rendered = renderNewLeadNotification({
      leadId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      origin: 'https://crm.example.test',
    });
    expect(rendered.subject).toBe(NOTIFICATION_SUBJECT);
    expect(rendered.html.startsWith('<!doctype html>')).toBe(true);
    // MJML emits the Outlook table resets and a fixed card width.
    expect(rendered.html).toContain('mso-table-lspace:0pt');
    expect(rendered.html).toContain('width="560"');
    expect(rendered.html).toContain('<!--[if mso]>');
    expect(rendered.html).not.toContain('{{');
    expect(rendered.html).toContain('A new lead just came in');
    expect(rendered.html).toContain('Open the lead');
    expect(rendered.html).toContain(
      'https://crm.example.test/leads/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
    expect(rendered.html).toContain(
      'https://crm.example.test/settings/account',
    );
    expect(rendered.text).toContain(
      'https://crm.example.test/leads/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
    // No contact fields, raw payloads, images, or tracking hooks.
    expect(rendered.html).not.toMatch(/<(img|script|iframe)/iu);
    expect(rendered.text).not.toContain('@example.test');
  });

  test('escapes dynamic values and test messages stay generic', () => {
    const rendered = renderNewLeadNotification({
      leadId: '"><script>',
      origin: 'https://crm.example.test',
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('%22%3E%3Cscript%3E');

    // The canonical origin is server-validated before storage; escaping is
    // defense in depth for any future template value.
    const escaped = renderTestEmail({
      origin: 'https://crm.example.test/?a=1&b="2"',
    });
    expect(escaped.html).toContain('&amp;');
    expect(escaped.html).toContain('&quot;');

    const testMessage = renderTestEmail({ origin: 'https://crm.example.test' });
    expect(testMessage.subject).toBe(TEST_SUBJECT);
    expect(testMessage.html.startsWith('<!doctype html>')).toBe(true);
    expect(testMessage.html).not.toContain('{{');
    expect(testMessage.html).toContain('Email is working');
    expect(testMessage.html).toContain('test email');
    expect(testMessage.html).not.toMatch(/<(img|script|iframe)/iu);
  });
});
