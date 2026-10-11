import {
  deliveryKeyFor,
  type EmailEnvelope,
  envelopePayloadHash,
  parseEnvelope,
  serializeEnvelope,
  testDeliveryKeyFor,
} from '@/notifications/email';
import {
  NOTIFICATION_SUBJECT,
  renderNewLeadNotification,
  renderTestEmail,
  TEST_SUBJECT,
} from '@/notifications/templates';
import { describe, expect, test } from 'vitest';

const envelope = (): EmailEnvelope => ({
  from: { email: 'notifications@example.test', name: 'LeadScroll' },
  html: '<p>Hello</p>',
  subject: NOTIFICATION_SUBJECT,
  text: 'Hello',
  to: 'staff@example.test',
});

describe('email envelope freezing', () => {
  test('serializes deterministically and parses back', () => {
    const value = envelope();
    const serialized = serializeEnvelope(value);
    expect(serialized).toBe(serializeEnvelope(value));
    expect(parseEnvelope(serialized)).toEqual(value);
  });

  test('drops an absent display name but keeps the address', () => {
    const withoutName = serializeEnvelope({
      ...envelope(),
      from: { email: 'notifications@example.test' },
    });
    expect(withoutName).not.toContain('"name"');
    expect(parseEnvelope(withoutName)?.from).toEqual({
      email: 'notifications@example.test',
    });
  });

  test('returns null for malformed frozen payloads', () => {
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope('{}')).toBeNull();
    expect(parseEnvelope('{"from":{"email":"a@b.c"}}')).toBeNull();
    expect(
      parseEnvelope(
        JSON.stringify({
          from: { email: 1 },
          html: 'x',
          subject: 's',
          text: 't',
          to: 'a@b.c',
        }),
      ),
    ).toBeNull();
  });

  test('hashes the exact wire payload', async () => {
    const first = await envelopePayloadHash(envelope());
    const second = await envelopePayloadHash(envelope());
    expect(first).toBe(second);
    expect(first).toMatch(/^[\da-f]{64}$/u);

    const changed = await envelopePayloadHash({
      ...envelope(),
      subject: 'A different subject',
    });
    expect(changed).not.toBe(first);
  });

  test('namespaces delivery keys', () => {
    expect(deliveryKeyFor('abc')).toBe('leadscroll-notification:abc');
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
    expect(testMessage.html).toContain('test email');
    expect(testMessage.html).not.toMatch(/<(img|script|iframe)/iu);
  });
});
