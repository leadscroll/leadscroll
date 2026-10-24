import { type NotificationAvailability } from '@/domain/schemas';
import { cn } from '@/lib/styles';

export const EmailAvailabilityChip = ({
  availability,
}: {
  readonly availability: NotificationAvailability;
}) => {
  const state =
    availability === 'configured'
      ? { dot: 'bg-emerald-400', label: 'Configured', tone: 'text-emerald-200' }
      : availability === 'misconfigured'
        ? { dot: 'bg-amber-400', label: 'Incomplete', tone: 'text-amber-200' }
        : { dot: 'bg-slate-500', label: 'Off', tone: 'text-slate-400' };

  return (
    <span className={cn('inline-flex items-center gap-2 text-xs', state.tone)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', state.dot)} />
      {state.label}
    </span>
  );
};
