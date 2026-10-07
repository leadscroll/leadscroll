import { BrandMark } from '@/components/BrandMark';
import { Avatar } from '@/components/ui/Avatar';
import { tagsPreviewEnabled } from '@/design-preview/tags/TagProvider';
import { signOut, useSession } from '@/lib/auth-client';
import { releaseLabel } from '@/lib/release';
import { cn } from '@/lib/styles';
import {
  ArrowUpRight,
  Bell,
  KeyRound,
  LayoutList,
  LogOut,
  Mail,
  Tags,
  Users,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';

const navigation = [
  { href: '/leads', icon: LayoutList, label: 'All leads' },
  ...(tagsPreviewEnabled
    ? [{ href: '/settings/tags', icon: Tags, label: 'Tags' }]
    : []),
  { href: '/settings/invites', icon: Mail, label: 'Invitations' },
  { href: '/settings/staff', icon: Users, label: 'Team members' },
  { href: '/settings/tokens', icon: KeyRound, label: 'Intake tokens' },
  ...(tagsPreviewEnabled
    ? [{ href: '/preview/toasts', icon: Bell, label: 'Toast preview' }]
    : []),
];

export const AppShell = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => {
  const [location] = useLocation();
  const { data: session } = useSession();
  const name = session?.user.name || 'Your account';

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
      >
        Skip to content
      </a>
      <aside className="app-sidebar">
        <Link
          className="workspace-brand"
          href="/leads"
        >
          <BrandMark />
          <span>
            LeadScroll <span className="workspace-caption">Workspace</span>
          </span>
        </Link>
        <nav
          aria-label="Main navigation"
          className="sidebar-navigation"
        >
          {navigation.map((item, index) => {
            const Icon = item.icon;
            const active =
              location === item.href ||
              location.startsWith(`${item.href}/`) ||
              (index === 0 && location === '/');
            return (
              <div key={item.href}>
                {(index === 0 || index === 1) && (
                  <p className="nav-section-label">
                    {index === 0 ? 'Workspace' : 'Manage'}
                  </p>
                )}
                <Link
                  aria-current={active ? 'page' : undefined}
                  className={cn('nav-item', active && 'nav-item-active')}
                  href={item.href}
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </Link>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <p className="release-label">
            LeadScroll <span>Alpha</span>
            <small>{releaseLabel(LEADSCROLL_BUILD_DATE)}</small>
          </p>
          <div className="account-row">
            <Link
              aria-current={
                location === '/settings/account' ? 'page' : undefined
              }
              className="account-link"
              href="/settings/account"
            >
              <Avatar name={name} />
              <span className="account-name">
                <strong>{name}</strong>
                <span>
                  Account settings <ArrowUpRight size={11} />
                </span>
              </span>
            </Link>
            <button
              aria-label="Sign out"
              className="icon-button"
              onClick={() => {
                void signOut();
              }}
              title="Sign out"
              type="button"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main
        className="app-main"
        id="main-content"
        tabIndex={-1}
      >
        {children}
      </main>
    </div>
  );
};
