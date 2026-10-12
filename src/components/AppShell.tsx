import { BrandMark } from '@/components/BrandMark';
import { Avatar } from '@/components/ui/Avatar';
import { signOut, useSession } from '@/lib/auth-client';
import { releaseLabel } from '@/lib/release';
import { cn } from '@/lib/styles';
import {
  ArrowUpRight,
  KeyRound,
  LayoutList,
  LogOut,
  Mail,
  Send,
  Tags,
  Users,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';

type NavigationItem = {
  href: string;
  icon: typeof LayoutList;
  label: string;
  section: 'Manage' | 'Workspace';
};

const navigation: NavigationItem[] = [
  {
    href: '/leads',
    icon: LayoutList,
    label: 'All leads',
    section: 'Workspace',
  },
  { href: '/settings/tags', icon: Tags, label: 'Tags', section: 'Manage' },
  {
    href: '/settings/invites',
    icon: Mail,
    label: 'Invitations',
    section: 'Manage',
  },
  {
    href: '/settings/staff',
    icon: Users,
    label: 'Team members',
    section: 'Manage',
  },
  {
    href: '/settings/tokens',
    icon: KeyRound,
    label: 'Intake tokens',
    section: 'Manage',
  },
  {
    href: '/settings/email',
    icon: Send,
    label: 'Email',
    section: 'Manage',
  },
];

const activeNavigation = (
  location: string,
  href: string,
  index: number,
): boolean =>
  location === href ||
  location.startsWith(`${href}/`) ||
  (index === 0 && location === '/');

export const AppShell = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => {
  const [location] = useLocation();
  const { data: session } = useSession();
  const name = session?.user.name || 'Your account';
  // Every enabled authenticated staff account can manage installation email
  // settings, so the entry is always visible; server routes still enforce
  // authentication and disabled-account rules.
  const visibleNavigation = navigation;

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
          {visibleNavigation.map((item, index) => {
            const Icon = item.icon;
            const showSection =
              index === 0 ||
              visibleNavigation[index - 1]?.section !== item.section;
            return (
              <div key={item.href}>
                {showSection && (
                  <p className="nav-section-label">{item.section}</p>
                )}
                <Link
                  aria-current={
                    activeNavigation(location, item.href, index)
                      ? 'page'
                      : undefined
                  }
                  className={cn(
                    'nav-item',
                    activeNavigation(location, item.href, index) &&
                      'nav-item-active',
                  )}
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
