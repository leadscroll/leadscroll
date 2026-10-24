import { type Invite, type StaffAccount, type Token } from './types';
import { request } from '@/lib/http';
import { toast } from 'sonner';

export const appQuery = {
  invites: () => ({
    queryFn: () => request<Invite[]>('/v1/invites'),
    queryKey: ['invites'],
  }),
  staff: () => ({
    queryFn: () => request<StaffAccount[]>('/v1/staff'),
    queryKey: ['staff'],
  }),
  tokens: () => ({
    queryFn: () => request<Token[]>('/v1/tokens'),
    queryKey: ['tokens'],
  }),
};

export const TOKEN_DEFAULT_TTL_MS = 90 * 86_400_000;

export const INVITE_DEFAULT_TTL_MS = 7 * 86_400_000;

export const inviteStatus = (
  invite: Invite,
): 'active' | 'expired' | 'revoked' | 'used' => {
  if (invite.revokedAt) {
    return 'revoked';
  }

  if (invite.usedAt) {
    return 'used';
  }

  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now()) {
    return 'expired';
  }

  return 'active';
};

export const copyToClipboard = async (value: string, message = 'Copied') => {
  await navigator.clipboard.writeText(value);
  toast.success(message);
};

export const publicIntakeSnippet = (token: string): string =>
  [
    `<form data-leadscroll="${token}">`,
    '  <input name="email" type="email" data-leadscroll-collect required>',
    '  <input name="message" data-leadscroll-collect placeholder="How can we help?">',
    '  <button type="submit">Send</button>',
    '</form>',
    `<script src="${window.location.origin}/sdk/v1.js" defer></script>`,
  ].join('\n');

export const tokenStatus = (
  token: Token,
): 'active' | 'expired' | 'never' | 'revoked' => {
  if (token.revokedAt) {
    return 'revoked';
  }

  if (!token.expiresAt) {
    return 'never';
  }

  if (new Date(token.expiresAt).getTime() <= Date.now()) {
    return 'expired';
  }

  return 'active';
};

export const statusTone = {
  active: 'text-emerald-300',
  expired: 'text-amber-300',
  never: 'text-sky-300',
  revoked: 'text-rose-300',
  used: 'text-violet-300',
} as const;
