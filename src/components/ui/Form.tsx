import {
  createContext,
  type FormHTMLAttributes,
  useContext,
  useState,
} from 'react';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const isControl = (element: unknown): element is Control =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLSelectElement ||
  element instanceof HTMLTextAreaElement;
const NativeErrors = createContext<Record<string, string>>({});
export const useNativeErrors = () => useContext(NativeErrors);

// Retain native required/type/min/pattern constraints, but present their messages
// next to Field instead of browser bubbles. RHF still owns domain/form rules.
export const Form = ({
  children,
  onChangeCapture,
  onSubmit,
  ...properties
}: FormHTMLAttributes<HTMLFormElement>) => {
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <NativeErrors.Provider value={errors}>
      <form
        {...properties}
        noValidate
        onChangeCapture={(event) => {
          const control = event.target;
          if (isControl(control) && control.name) {
            setErrors((current) => {
              if (!(control.name in current)) {
                return current;
              }

              return control.validity.valid
                ? Object.fromEntries(
                    Object.entries(current).filter(
                      ([name]) => name !== control.name,
                    ),
                  )
                : { ...current, [control.name]: control.validationMessage };
            });
          }

          onChangeCapture?.(event);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          const invalid: Control[] = [];
          for (const element of event.currentTarget.elements) {
            if (
              isControl(element) &&
              element.name &&
              element.willValidate &&
              !element.validity.valid
            ) {
              invalid.push(element);
            }
          }

          setErrors(
            Object.fromEntries(
              invalid.map((control) => [
                control.name,
                control.validationMessage,
              ]),
            ),
          );
          if (invalid.length) {
            event.preventDefault();
            invalid[0].focus();
            return;
          }

          onSubmit?.(event);
        }}
      >
        {children}
      </form>
    </NativeErrors.Provider>
  );
};
