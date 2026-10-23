export type Invite = {
  createdAt: string;
  expiresAt: null | string;
  id: string;
  name: string;
  prefix: string;
  revokedAt: null | string;
  usedAt: null | string;
};

export type StaffAccount = {
  disabledAt: null | string;
  email: string;
  id: string;
  name: string;
};

export type Token = {
  createdAt: string;
  expiresAt: null | string;
  id: string;
  name: string;
  prefix: string;
  revokedAt: null | string;
  token: null | string;
  type: 'api' | 'browser';
};
