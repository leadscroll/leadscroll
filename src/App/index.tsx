import { AccountSessionCacheBoundary } from '../account/AccountSessionCacheBoundary';
import { AppContent } from './AppContent';

export const App = () => (
  <AccountSessionCacheBoundary>
    <AppContent />
  </AccountSessionCacheBoundary>
);
