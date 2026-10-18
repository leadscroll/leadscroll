import {
  type EmailSettingsView,
  type EmailTestView,
  savedConfigurationTestable,
} from '../api';
import { TEST_OUTCOME_TITLES } from './labels';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/styles';

const formatTimestamp = (value: null | string): string =>
  value === null ? '—' : new Date(value).toLocaleString();

const outcomeTone = (outcome: EmailTestView['outcome']): string =>
  outcome === 'accepted'
    ? 'text-emerald-200'
    : outcome === 'sending'
      ? 'text-slate-300'
      : 'text-amber-200';

/**
 * Verification is the last step of the page, after the current configuration
 * and the way to change it. The test always runs against the *saved* method,
 * so it is disabled while a draft is open.
 */
export const SetupCheck = ({
  accountEmail,
  editing,
  onSendTest,
  pending,
  settings,
  testResult,
}: {
  readonly accountEmail: string;
  readonly editing: boolean;
  readonly onSendTest: () => void;
  readonly pending: boolean;
  readonly settings: EmailSettingsView;
  readonly testResult: EmailTestView | null;
}) => {
  const testable = savedConfigurationTestable(settings);
  const savedTest = settings.test;
  // A mutation result only applies to the revision it ran against; a
  // background save elsewhere must not leave a stale "accepted" on screen.
  const currentTest =
    testResult !== null && testResult.revision === settings.revision
      ? testResult
      : savedTest !== null && savedTest.revision === settings.revision
        ? savedTest
        : null;
  const staleTestAt =
    currentTest === null ? (testResult?.at ?? savedTest?.at ?? null) : null;

  let title = 'Not tested';
  let detail = 'No test has been sent for the current settings.';
  let tone = 'text-slate-300';

  if (editing) {
    title = 'Finish editing to test';
    detail = 'Testing uses the saved configuration, not this draft.';
    tone = 'text-slate-400';
  } else if (!testable.ok) {
    title = 'Not available';
    detail = testable.message;
    tone = 'text-slate-400';
  } else if (currentTest !== null) {
    title = TEST_OUTCOME_TITLES[currentTest.outcome];
    tone = outcomeTone(currentTest.outcome);
    detail = `${formatTimestamp(currentTest.at)} · sent to ${accountEmail}`;
  } else if (staleTestAt !== null) {
    title = 'Tested before your last change';
    detail = `${formatTimestamp(staleTestAt)} · send again to confirm the current settings.`;
    tone = 'text-slate-400';
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="border-b border-slate-800 px-5 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Check your setup
        </h2>
      </div>
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className={cn('text-sm font-medium', tone)}>{title}</p>
            <p className="mt-1 text-xs text-slate-500">{detail}</p>
          </div>
          <Button
            disabled={pending || editing || !testable.ok}
            onClick={onSendTest}
            tone="secondary"
          >
            {pending ? 'Sending…' : 'Send test email'}
          </Button>
        </div>
        {testable.ok && !editing && (
          <p className="mt-3 border-t border-slate-800 pt-3 text-xs text-slate-500">
            Sends only to your account email. One attempt; an unknown outcome is
            not retried.
          </p>
        )}
      </div>
    </section>
  );
};
