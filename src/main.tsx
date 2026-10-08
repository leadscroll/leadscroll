import { App } from './App';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

const rootElement = document.querySelector('#root');
if (rootElement === null) {
  throw new Error('The #root element is missing from the page');
}

// Safari/iOS still lack Temporal. If the polyfill chunk cannot be fetched the
// app cannot resolve date inputs, so surface a retry instead of a blank page.
const BootError = () => (
  <div className="grid min-h-screen place-items-center bg-slate-950 p-4 text-slate-100">
    <div
      className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/70 p-6 text-sm"
      role="alert"
    >
      <p className="font-semibold text-white">LeadScroll could not start.</p>
      <p className="mt-2 text-slate-300">
        The date library failed to load. Check your connection and try again.
      </p>
      <button
        className="mt-4 rounded-md bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300"
        onClick={() => {
          window.location.reload();
        }}
        type="button"
      >
        Retry
      </button>
    </div>
  </div>
);

const start = async () => {
  if (!('Temporal' in globalThis)) {
    try {
      await import('temporal-polyfill/global');
    } catch {
      createRoot(rootElement).render(<BootError />);
      return;
    }
  }

  createRoot(rootElement).render(
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster
        closeButton
        duration={5_000}
        position="bottom-right"
        theme="dark"
        toastOptions={{
          classNames: {
            actionButton: 'leadscroll-toast-action',
            description: 'leadscroll-toast-description',
            toast: 'leadscroll-toast',
          },
          closeButtonAriaLabel: 'Dismiss notification',
        }}
      />
    </QueryClientProvider>,
  );
};

void start();
