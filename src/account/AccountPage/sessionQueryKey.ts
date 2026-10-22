export const sessionQueryKey = (userId: string, sessionId: string) =>
  ['account-sessions', userId, sessionId] as const;
