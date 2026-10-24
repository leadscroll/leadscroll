export const ErrorState = ({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}) => (
  <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
    {error instanceof Error ? error.message : 'Something went wrong.'}
    {onRetry && (
      <button
        className="ml-3 font-semibold text-cyan-300 hover:text-cyan-200"
        onClick={onRetry}
        type="button"
      >
        Try again
      </button>
    )}
  </div>
);
