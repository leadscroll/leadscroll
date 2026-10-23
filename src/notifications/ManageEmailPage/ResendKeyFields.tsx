import {
  type ManageEmailFormValues,
  STORED_API_KEY_SENTINEL,
} from './saveVariables';
import { Field } from '@/components/ui/Field';
import { inputClass } from '@/components/ui/form';
import { type UseFormRegister } from 'react-hook-form';

const selectStoredKey = (
  event:
    React.FocusEvent<HTMLInputElement> | React.MouseEvent<HTMLInputElement>,
) => {
  if (event.currentTarget.value === STORED_API_KEY_SENTINEL) {
    event.currentTarget.select();
  }
};

export const ResendKeyFields = ({
  apiKeyError,
  hasStoredKey,
  pending,
  register,
  removeKey,
}: {
  readonly apiKeyError?: string;
  readonly hasStoredKey: boolean;
  readonly pending: boolean;
  readonly register: UseFormRegister<ManageEmailFormValues>;
  readonly removeKey: boolean;
}) => (
  <div className="grid max-w-md gap-3">
    <Field
      error={apiKeyError}
      hint={
        hasStoredKey
          ? 'A key is stored. Leave the masked value unchanged to keep it, or type a new key to replace it.'
          : 'Write-only: it is never redisplayed, cached, or stored in the browser.'
      }
      label="Resend API key"
    >
      <input
        autoComplete="new-password"
        className={inputClass}
        disabled={pending || removeKey}
        onClick={selectStoredKey}
        onFocus={selectStoredKey}
        placeholder={hasStoredKey ? undefined : 're_…'}
        type="password"
        {...register('apiKey')}
      />
    </Field>
    {hasStoredKey && (
      <label className="flex items-start gap-2 text-xs text-slate-400">
        <input
          className="mt-0.5"
          disabled={pending}
          type="checkbox"
          {...register('removeKey')}
        />
        <span>
          Remove the stored key. Saving switches sending to Off and keeps the
          sender details.
        </span>
      </label>
    )}
    {removeKey && (
      <p className="text-xs text-rose-200">
        The key will be removed and sending will switch to Off when you save.
      </p>
    )}
  </div>
);
