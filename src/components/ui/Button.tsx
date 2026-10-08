import { cn } from '@/lib/styles';
import { type ButtonHTMLAttributes } from 'react';

type ButtonProperties = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly tone?: 'danger' | 'ghost' | 'primary' | 'secondary';
};

export const Button = ({
  className,
  tone = 'primary',
  ...properties
}: ButtonProperties) => (
  <button
    className={cn('ui-button', `ui-button-${tone}`, className)}
    type="button"
    {...properties}
  />
);
