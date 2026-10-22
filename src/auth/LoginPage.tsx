import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { signIn, signUp } from '@/lib/auth-client';
import { quietFetch } from '@/lib/quiet-fetch';
import {
  initialRegistrationState,
  isInviteUnavailable,
  registrationReducer,
  type SignUpFailure,
} from '@/lib/registration-flow';
import { useReducer, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

export const LoginPage = () => {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const signInForm = useForm<{ email: string; password: string }>({
    defaultValues: { email: '', password: '' },
    mode: 'onTouched',
  });
  const signInError = signInForm.formState.errors.root?.server?.message;
  const signInPending = signInForm.formState.isSubmitting;
  const tokenForm = useForm<{ inviteToken: string }>({
    defaultValues: { inviteToken: '' },
    mode: 'onTouched',
  });
  const detailsForm = useForm<{
    email: string;
    name: string;
    password: string;
  }>({
    defaultValues: { email: '', name: '', password: '' },
    mode: 'onTouched',
  });
  const [registration, dispatch] = useReducer(
    registrationReducer,
    undefined,
    initialRegistrationState,
  );
  // Synchronous guard so a fast double submit cannot start a second
  // request before the reducer's busy flag has re-rendered.
  const registrationBusy = useRef(false);

  const releaseRegistration = () => {
    registrationBusy.current = false;
  };

  // The synchronous guard is claimed by the JSX submit handlers (not by the
  // handleSubmit callbacks, which the compiler would treat as render-time
  // calls) so a fast double submit cannot start a second request before the
  // reducer's busy flag has re-rendered.
  const claimRegistration = (): boolean => {
    if (registrationBusy.current) {
      return false;
    }

    registrationBusy.current = true;
    return true;
  };

  const { busy: pending, error, step } = registration;

  // Clears the form values the reducer cannot reach; every transition that
  // restarts the flow calls this so the token and the credentials do not
  // outlive the step that collected them.
  const resetRegistrationForms = () => {
    tokenForm.reset();
    detailsForm.reset();
  };

  const startRegistration = () => {
    setMode('sign-up');
    resetRegistrationForms();
    dispatch({ type: 'begin-registration' });
  };

  const backToSignIn = () => {
    setMode('sign-in');
  };

  const submitSignIn = signInForm.handleSubmit(async (values) => {
    signInForm.clearErrors('root.server');
    const result = await signIn.email(values);
    if (result.error) {
      signInForm.setError('root.server', {
        message: result.error.message ?? 'Authentication failed.',
      });
    }
  });

  const submitTokenValues = tokenForm.handleSubmit(async ({ inviteToken }) => {
    dispatch({ type: 'token-submit' });
    try {
      const response = await quietFetch('/api/invites/validate', {
        body: JSON.stringify({ token: inviteToken.trim() }),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });
      dispatch({ ok: response.ok, type: 'token-result' });
    } catch {
      dispatch({ ok: false, type: 'token-result' });
    }
  });

  const handleTokenSubmit = async (event: React.FormEvent) => {
    // Cancel the native submission first: if the synchronous guard rejects the
    // duplicate, the password/token inputs must never fall through to a GET.
    event.preventDefault();
    if (!claimRegistration()) {
      return;
    }

    try {
      await submitTokenValues(event);
    } finally {
      releaseRegistration();
    }
  };

  const submitDetailsValues = detailsForm.handleSubmit(async (values) => {
    dispatch({ type: 'details-submit' });
    const result = await signUp.email({
      email: values.email,
      fetchOptions: {
        headers: { 'X-Setup-Token': tokenForm.getValues('inviteToken').trim() },
      },
      name: values.name,
      password: values.password,
    });
    if (result.error && isInviteUnavailable(result.error)) {
      // The grant stopped being usable while the details were typed: drop
      // the token and the credentials together with the step.
      resetRegistrationForms();
    }

    dispatch({
      error: (result.error ?? null) as null | SignUpFailure,
      type: 'details-result',
    });
  });

  const handleDetailsSubmit = async (event: React.FormEvent) => {
    // Cancel the native submission first: if the synchronous guard rejects the
    // duplicate, the credentials must never fall through to a GET.
    event.preventDefault();
    if (!claimRegistration()) {
      return;
    }

    try {
      await submitDetailsValues(event);
    } finally {
      releaseRegistration();
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-slate-950 p-4 text-slate-100">
      <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/70 p-6">
        <div className="mb-6 flex items-center gap-2 text-sm font-bold tracking-tight text-white">
          <BrandMark />
          LeadScroll
        </div>
        {mode === 'sign-in' ? (
          <Form
            className="grid gap-4"
            onSubmit={submitSignIn}
          >
            <Field label="Email">
              <input
                placeholder="you@example.com"
                required
                type="email"
                {...signInForm.register('email')}
              />
            </Field>
            <Field label="Password">
              <input
                minLength={8}
                required
                type="password"
                {...signInForm.register('password')}
              />
            </Field>
            {signInError && (
              <p
                className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100"
                role="alert"
              >
                {signInError}
              </p>
            )}
            <Button
              disabled={signInPending}
              type="submit"
            >
              {signInPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </Form>
        ) : step === 1 ? (
          <Form
            className="grid gap-4"
            onSubmit={handleTokenSubmit}
          >
            <Field
              error={tokenForm.formState.errors.inviteToken?.message}
              label="Invite token"
            >
              <input
                placeholder="Shared with you by a staff member"
                required
                {...tokenForm.register('inviteToken', {
                  validate: (value) =>
                    Boolean(value.trim()) || 'Enter an invite token.',
                })}
              />
            </Field>
            {error && (
              <p
                className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100"
                role="alert"
              >
                {error}
              </p>
            )}
            <Button
              disabled={pending}
              type="submit"
            >
              {pending ? 'Checking…' : 'Continue'}
            </Button>
          </Form>
        ) : (
          <Form
            className="grid gap-4"
            onSubmit={handleDetailsSubmit}
          >
            <Field
              error={detailsForm.formState.errors.name?.message}
              label="Name"
            >
              <input
                placeholder="Ada Lovelace"
                required
                {...detailsForm.register('name', {
                  validate: (value) =>
                    Boolean(value.trim()) || 'Enter your name.',
                })}
              />
            </Field>
            <Field label="Email">
              <input
                placeholder="you@example.com"
                required
                type="email"
                {...detailsForm.register('email')}
              />
            </Field>
            <Field label="Password">
              <input
                minLength={8}
                required
                type="password"
                {...detailsForm.register('password')}
              />
            </Field>
            {error && (
              <p
                className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100"
                role="alert"
              >
                {error}
              </p>
            )}
            <Button
              disabled={pending}
              onClick={() => {
                resetRegistrationForms();
                dispatch({ type: 'back-to-token' });
              }}
              tone="secondary"
              type="button"
            >
              Back
            </Button>
            <Button
              disabled={pending}
              type="submit"
            >
              {pending ? 'Creating…' : 'Create account'}
            </Button>
          </Form>
        )}
        {mode === 'sign-in' ? (
          <button
            className="mt-4 text-sm text-cyan-300 hover:text-cyan-200"
            onClick={startRegistration}
            type="button"
          >
            Create account
          </button>
        ) : step === 1 ? (
          <button
            className="mt-4 text-sm text-cyan-300 hover:text-cyan-200"
            disabled={pending}
            onClick={backToSignIn}
            type="button"
          >
            Sign in
          </button>
        ) : null}
      </div>
    </div>
  );
};
