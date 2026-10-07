import { Field } from '@/components/ui/Field';
import { inputClass } from '@/components/ui/form';
import { useTags } from '@/design-preview/tags/TagProvider';
import { type LeadFormValues } from '@/leads/leadFormValues';
import { type UseFormRegister } from 'react-hook-form';

// The proposal replaces the source control with tags; production keeps its contract.
export const LeadSourceField = ({
  register,
}: {
  readonly register: UseFormRegister<LeadFormValues>;
}) => {
  const tags = useTags();
  return tags ? null : (
    <Field label="Source">
      <input
        className={inputClass}
        placeholder="e.g. Website"
        {...register('source')}
      />
    </Field>
  );
};
