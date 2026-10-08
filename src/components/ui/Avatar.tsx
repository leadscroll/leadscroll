import { cn } from '@/lib/styles';

export const Avatar = ({
  large = false,
  name,
}: {
  readonly large?: boolean;
  readonly name: string;
}) => (
  <span
    aria-hidden="true"
    className={cn('avatar', large && 'avatar-large')}
  >
    {name
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '?'}
  </span>
);
