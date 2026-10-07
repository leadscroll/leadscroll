import { Field } from '@/components/ui/Field';
import { inputClass } from '@/components/ui/form';
import { localTimezoneLabel, wallClockIssue } from '@/lib/datetime';
import { tokenExpiration, type TokenFormValues } from '@/lib/tokenFormValues';
import { useId } from 'react';
import { type UseFormReturn } from 'react-hook-form';

export const TokenExpirationField = ({
  form,
  onPresetChange,
  referenceTime,
}: {
  readonly form: UseFormReturn<TokenFormValues>;
  readonly onPresetChange: () => void;
  readonly referenceTime: number;
}) => {
  const mode = form.watch('expirationMode');
  const expiration = form.watch('expiration');
  const hintId = useId();
  const timezoneId = useId();
  const expiresAt = tokenExpiration(
    { expiration, expirationMode: mode },
    referenceTime,
  );

  return (
    <div className="token-expiration">
      <Field label="Expiration">
        <select
          aria-describedby={mode === 'custom' ? undefined : hintId}
          className={inputClass}
          {...form.register('expirationMode', {
            onChange: () => {
              form.clearErrors('expiration');
              onPresetChange();
            },
          })}
        >
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="never">Never</option>
          <option value="custom">Custom date…</option>
        </select>
      </Field>
      {mode === 'custom' ? (
        <div className="token-custom-expiration">
          <Field
            error={form.formState.errors.expiration?.message}
            label="Expiration date"
          >
            <input
              aria-describedby={timezoneId}
              aria-invalid={form.formState.errors.expiration ? true : undefined}
              className={inputClass}
              required
              type="datetime-local"
              {...form.register('expiration', {
                validate: (value) =>
                  form.getValues('expirationMode') !== 'custom' ||
                  (value
                    ? wallClockIssue(value)
                    : 'Choose an expiration date.'),
              })}
            />
          </Field>
          <p
            className="field-hint"
            id={timezoneId}
          >
            Local time ({localTimezoneLabel(expiration)})
          </p>
        </div>
      ) : (
        <p
          aria-live="polite"
          className="field-hint"
          id={hintId}
        >
          {mode === 'never'
            ? 'Valid until revoked.'
            : `Expires ${new Date(expiresAt ?? referenceTime).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}.`}
        </p>
      )}
    </div>
  );
};
