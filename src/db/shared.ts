import { createClient } from './driver';
import { type Env } from './env';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const now = (): Date => new Date();

export const id = (): string => {
  let timestamp = Date.now();
  let result = '';
  for (let index = 0; index < 10; index += 1) {
    result = ULID_ALPHABET[timestamp % 32] + result;
    timestamp = Math.floor(timestamp / 32);
  }

  const random = crypto.getRandomValues(new Uint8Array(16));
  return (
    result + Array.from(random, (value) => ULID_ALPHABET[value % 32]).join('')
  );
};

export const randomToken = (prefix: string): string =>
  `${prefix}${crypto
    .getRandomValues(new Uint8Array(32))
    .reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), '')}`;

export const hashToken = async (token: string): Promise<string> => {
  const source = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', source);
  return Array.from(new Uint8Array(hash))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
};

export const getDatabase = (environment: Env) => createClient(environment.DB);

export const errorText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current !== null && current !== undefined;
    depth += 1
  ) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return parts.join(' | ');
};

export const isUniqueViolation = (error: unknown): boolean =>
  /UNIQUE constraint failed/iu.test(errorText(error));

// A transaction-time guard deliberately inserts a NULL into a NOT NULL column
// to abort the whole batch when a requested row disappeared concurrently.
export const isNotNullViolation = (error: unknown): boolean =>
  /NOT NULL constraint failed/iu.test(errorText(error));

export const uniqueConstraintTarget = (error: unknown): null | string => {
  const match = /UNIQUE constraint failed: ([\w.]+)/iu.exec(errorText(error));
  return match?.[1]?.toLowerCase() ?? null;
};

export {
  type Database,
  executeAtomically,
  executeAtomicallyWithResults,
  prepare,
  type Statement,
} from './driver';
