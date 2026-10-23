import { NotificationsSection } from './NotificationsSection';
import { PasswordSection } from './PasswordSection';
import { ProfileSection } from './ProfileSection';
import { SessionsSection } from './SessionsSection';
import { PageHeader } from '@/components/PageHeader';
import { useSession } from '@/lib/auth-client';

export const AccountPage = () => {
  const { data: session, isPending } = useSession();
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Account"
      />
      {isPending || !session ? (
        <p className="p-5 text-slate-400">Loading account…</p>
      ) : (
        <div
          className="grid grid-cols-1 gap-6 p-5 sm:p-8"
          key={session.user.id}
        >
          <ProfileSection
            email={session.user.email}
            name={session.user.name}
            updatedAt={new Date(session.user.updatedAt)}
          />
          <NotificationsSection
            email={session.user.email}
            userId={session.user.id}
          />
          <PasswordSection />
          <SessionsSection
            key={session.session.id}
            sessionId={session.session.id}
            userId={session.user.id}
          />
        </div>
      )}
    </>
  );
};
