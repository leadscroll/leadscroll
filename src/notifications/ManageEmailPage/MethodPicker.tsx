import { type ManageEmailFormValues } from './saveVariables';
import { cn } from '@/lib/styles';
import { type UseFormRegister } from 'react-hook-form';

const METHODS = [
  {
    description: "Uses this deployment's Cloudflare Email binding.",
    label: 'Cloudflare Email Sending',
    value: 'cloudflare',
  },
  {
    description: 'Sends over HTTPS with an encrypted API key.',
    label: 'Resend',
    value: 'resend',
  },
  {
    description: 'No lead email is sent. Staff preferences are kept.',
    label: 'Off',
    value: 'disabled',
  },
] as const;

/**
 * The sending method is a stored configuration choice, so it is presented as
 * radio cards rather than a dropdown: each option carries its prerequisite at
 * the point of choosing, and native radios keep group semantics and keyboard
 * behavior.
 */
export const MethodPicker = ({
  register,
  value,
}: {
  readonly register: UseFormRegister<ManageEmailFormValues>;
  readonly value: ManageEmailFormValues['provider'];
}) => (
  <fieldset className="min-w-0">
    <legend className="field-label">Method</legend>
    <div className="mt-2 grid gap-2.5 sm:grid-cols-3">
      {METHODS.map((method) => {
        const selected = value === method.value;
        return (
          <label
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors',
              selected
                ? 'border-cyan-400 bg-cyan-400/5'
                : 'border-slate-700 bg-slate-950/40 hover:border-slate-600',
            )}
            key={method.value}
          >
            <input
              className="mt-0.5 shrink-0"
              type="radio"
              value={method.value}
              {...register('provider')}
            />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-slate-100">
                {method.label}
              </span>
              <span className="mt-1 block text-[11px] leading-snug text-slate-500">
                {method.description}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  </fieldset>
);
