import { InvitesPage } from '../access/InvitesPage';
import { StaffPage } from '../access/StaffPage';
import { TokensPage } from '../access/TokensPage';
import { AccountPage } from '../account/AccountPage';
import { LoginPage } from '../auth/LoginPage';
import { AppShell as Shell } from '../components/AppShell';
import { LeadDetailPage } from '../leads/LeadDetailPage';
import { LeadsPage } from '../leads/LeadsPage';
import { useSession } from '../lib/auth-client';
import { ManageEmailPage } from '../notifications/ManageEmailPage';
import { TagsPage } from '../tags/TagsPage';
import { Route, Switch } from 'wouter';

export const AppContent = () => {
  const { data: session, isPending } = useSession();
  if (isPending) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-950 text-sm text-slate-400">
        Loading…
      </div>
    );
  }

  if (!session) {
    return <LoginPage />;
  }

  return (
    <Shell>
      <Switch>
        <Route path="/leads/:id">
          {(parameters) => (
            <LeadDetailPage
              id={parameters.id}
              key={parameters.id}
            />
          )}
        </Route>
        <Route path="/leads">
          <LeadsPage />
        </Route>
        <Route path="/settings/tags">
          <TagsPage />
        </Route>
        <Route path="/settings/account">
          <AccountPage />
        </Route>
        <Route path="/settings/tokens">
          <TokensPage />
        </Route>
        <Route path="/settings/email">
          <ManageEmailPage />
        </Route>
        <Route path="/settings/invites">
          <InvitesPage />
        </Route>
        <Route path="/settings/staff">
          <StaffPage />
        </Route>
        <Route>
          <LeadsPage />
        </Route>
      </Switch>
    </Shell>
  );
};
