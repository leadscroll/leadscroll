import { useNativeErrors } from './Form';
import {
  type AriaAttributes,
  Children,
  cloneElement,
  isValidElement,
  type ReactNode,
  useId,
} from 'react';

type ControlProperties = AriaAttributes & { id?: string; name?: string };

export const Field = ({
  children,
  error,
  hint,
  label,
}: {
  readonly children: ReactNode;
  readonly error?: string;
  readonly hint?: string;
  readonly label: string;
}) => {
  const generatedId = useId();
  const nativeErrors = useNativeErrors();
  const control = Children.toArray(children).find(
    (child) =>
      isValidElement<ControlProperties>(child) &&
      ['input', 'select', 'textarea'].includes(String(child.type)),
  );
  const properties = isValidElement<ControlProperties>(control)
    ? control.props
    : {};
  const id = properties.id ?? generatedId;
  const message = error ?? nativeErrors[properties.name ?? ''];
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="ui-field">
      <label
        className="field-label"
        htmlFor={id}
      >
        {label}
      </label>
      {hint ? (
        <span
          className="field-hint"
          id={hintId}
        >
          {hint}
        </span>
      ) : null}
      {Children.map(children, (child) =>
        isValidElement<ControlProperties>(child) &&
        ['input', 'select', 'textarea'].includes(String(child.type))
          ? cloneElement(child, {
              'aria-describedby':
                [
                  properties['aria-describedby'],
                  hint && hintId,
                  message && errorId,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined,
              'aria-invalid': message ? true : properties['aria-invalid'],
              id,
            })
          : child,
      )}
      {message ? (
        <span
          className="field-error"
          id={errorId}
          role="alert"
        >
          {message}
        </span>
      ) : null}
    </div>
  );
};
