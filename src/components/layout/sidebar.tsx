'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useTotalUnread } from '@/hooks/use-total-unread';
import { useUnreadNotifications } from '@/hooks/use-unread-notifications';
import {
  Bell,
  Bot,
  Crown,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Megaphone,
  Settings,
  Shield,
  User,
  UserCog,
  Users,
  UsersRound,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import type { AccountRole } from '@/lib/auth/roles';

// Per-role chip metadata used in the sidebar's account strip + the
// Members tab roster. Keeping this near both consumers in a single
// place avoids drift between the two surfaces — when a designer
// wants to recolour "agent" rows, this is the one diff.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; labelKey: string; className: string }
> = {
  owner: {
    icon: Crown,
    labelKey: 'roleOwner',
    // Amber: scarce, immutable, "the boss" — gets visual emphasis.
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  },
  admin: {
    icon: Shield,
    labelKey: 'roleAdmin',
    // Primary-tinted: significant but not as scarce as owner.
    className: 'border-primary/40 bg-primary/10 text-primary',
  },
  agent: {
    icon: UserCog,
    labelKey: 'roleAgent',
    // Neutral slate: the operational default.
    className: 'border-border bg-muted text-foreground',
  },
  viewer: {
    icon: User,
    labelKey: 'roleViewer',
    // Muted slate: read-only role; visually quieter than agent.
    className: 'border-border bg-card text-muted-foreground',
  },
};
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

const navItems: NavItem[] = [
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/inbox', labelKey: 'inbox', icon: MessageSquare },
  { href: '/notifications', labelKey: 'notifications', icon: Bell },
  { href: '/contacts', labelKey: 'contacts', icon: Users },
  { href: '/pipelines', labelKey: 'pipelines', icon: GitBranch },
  { href: '/campaigns', labelKey: 'campaigns', icon: Megaphone },
  { href: '/automations', labelKey: 'automations', icon: Zap },
  { href: '/flows', labelKey: 'flows', icon: Workflow, beta: true },
  { href: '/agents', labelKey: 'aiAgents', icon: Bot },
];

const bottomNavItems = [
  { href: '/settings', labelKey: 'settings', icon: Settings },
];

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

import { useTranslations } from 'next-intl';

export function Sidebar({
  open = false,
  onClose,
  collapsed,
  onToggleCollapse,
}: SidebarProps) {
  const t = useTranslations('Sidebar');
  const pathname = usePathname();
  const { profile, profileLoading, account, accountRole, signOut } = useAuth();
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  const showAccountStrip =
    !profileLoading && !!account?.name && account.name !== profile?.full_name;

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label={t('closeMenu')}
        onClick={onClose}
        className={cn(
          'bg-background/70 fixed inset-0 z-30 backdrop-blur-sm transition-opacity lg:hidden',
          open
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          'border-border bg-card fixed inset-y-0 left-0 z-40 flex h-full w-64 shrink-0 flex-col border-r',
          'transition-[width,transform] duration-200 ease-out will-change-[width,transform]',
          open ? 'translate-x-0' : '-translate-x-full',
          'lg:static lg:z-0 lg:translate-x-0',
          collapsed ? 'lg:w-16' : 'lg:w-64'
        )}
        aria-label={t('primaryNav')}
      >
        <div
          className={cn(
            'border-border relative flex min-h-16 shrink-0 items-center justify-between gap-2 border-b px-4 py-3',
            collapsed &&
              'lg:min-h-0 lg:flex-col lg:items-center lg:justify-start lg:gap-3 lg:px-0 lg:pt-3 lg:pb-2'
          )}
        >
          <Link
            href="/dashboard"
            className={cn(
              'flex min-w-0 flex-1 shrink-0 items-center',
              collapsed && 'lg:mx-auto lg:flex-none'
            )}
          >
            <span className={cn('flex items-center', collapsed && 'lg:hidden')}>
              <Image
                src="/logo.svg"
                alt="Automize CRM"
                width={351}
                height={51}
                priority
                className="block h-10 w-auto max-w-[210px] object-contain"
              />
            </span>
            {collapsed && (
              <Image
                src="/logo-icon.svg"
                alt="Automize CRM"
                width={512}
                height={512}
                priority
                className="mx-auto hidden h-7 w-7 object-contain lg:block"
              />
            )}
          </Link>
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={t(collapsed ? 'expandSidebar' : 'collapseSidebar')}
            title={t(collapsed ? 'expandSidebar' : 'collapseSidebar')}
            aria-expanded={!collapsed}
            className={cn(
              'focus-visible:ring-ring hidden shrink-0 items-center justify-center focus-visible:ring-2 focus-visible:outline-none lg:flex',
              collapsed
                ? 'rounded-md p-1.5 text-neutral-400 transition hover:bg-neutral-800 hover:text-white'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground h-9 w-9 rounded-md'
            )}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('closeMenu')}
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 w-9 items-center justify-center rounded-md lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-1">
            {navItems.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== '/dashboard' &&
                  pathname.startsWith(item.href)) ||
                (item.href === '/campaigns' &&
                  (pathname.startsWith('/broadcasts') ||
                    pathname.startsWith('/webinars')));

              const showUnreadDot =
                item.href === '/inbox' && totalUnread > 0 && !isActive;

              // Unlike the inbox dot, the notifications count stays visible
              // even while the page is active — it reflects unread state
              // (cleared by marking notifications read), not "currently
              // viewing this section".
              const showNotificationBadge =
                item.href === '/notifications' && unreadNotifications > 0;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      // Taller on mobile so fingers can hit the row reliably (≥44px).
                      'relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2',
                      collapsed && 'lg:justify-center lg:gap-0 lg:px-0',
                      isActive
                        ? item.href === '/campaigns'
                          ? 'border border-orange-500/20 bg-orange-500/10 font-medium text-orange-400'
                          : 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                    aria-label={
                      collapsed ? t(item.labelKey as string) : undefined
                    }
                    title={collapsed ? t(item.labelKey as string) : undefined}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className={cn('flex-1', collapsed && 'lg:hidden')}>
                      {t(item.labelKey as string)}
                    </span>
                    {item.beta && (
                      <span
                        aria-label={t('beta')}
                        className={cn(
                          'rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-amber-300 uppercase',
                          collapsed && 'lg:hidden'
                        )}
                      >
                        {t('beta')}
                      </span>
                    )}
                    {showUnreadDot && (
                      <span
                        aria-label={t('unreadConversations', {
                          count: totalUnread,
                        })}
                        className={cn(
                          'relative flex h-2 w-2',
                          collapsed && 'lg:absolute lg:top-1 lg:right-1'
                        )}
                      >
                        <span className="bg-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
                        <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
                      </span>
                    )}
                    {showNotificationBadge && (
                      <span
                        aria-label={t('unreadNotifications', {
                          count: unreadNotifications,
                        })}
                        className={cn(
                          'bg-primary text-primary-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold',
                          collapsed &&
                            'lg:absolute lg:top-0 lg:right-0 lg:h-4 lg:min-w-4 lg:text-[9px]'
                        )}
                      >
                        {unreadNotifications > 9 ? '9+' : unreadNotifications}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="border-border my-4 border-t" />

          <ul className="flex flex-col gap-1">
            {bottomNavItems.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2',
                      collapsed && 'lg:justify-center lg:gap-0 lg:px-0',
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                    aria-label={
                      collapsed ? t(item.labelKey as string) : undefined
                    }
                    title={collapsed ? t(item.labelKey as string) : undefined}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className={cn(collapsed && 'lg:hidden')}>
                      {t(item.labelKey as string)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User section */}
        <div
          className={cn(
            'border-border shrink-0 border-t p-3',
            collapsed && 'lg:p-2'
          )}
        >
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. */}
          {showAccountStrip && account?.name ? (
            <div
              className={cn(
                'text-muted-foreground mb-2 flex items-center gap-2 px-3 text-xs',
                collapsed && 'lg:hidden'
              )}
            >
              <UsersRound className="size-3.5 shrink-0" />
              {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole
                ? // Always render the chip — owners used to be
                  // invisible here, which made them indistinguishable
                  // from admins at a glance. Now everyone sees their
                  // role (with a colour cue) regardless of tier.
                  (() => {
                    const meta = ROLE_CHIP[accountRole];
                    const Icon = meta.icon;
                    return (
                      <span
                        className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase ${meta.className}`}
                      >
                        <Icon className="size-3" />
                        {t(meta.labelKey as string)}
                      </span>
                    );
                  })()
                : null}
            </div>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'hover:bg-muted/60 focus:bg-muted/60 data-popup-open:bg-muted/60 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus:outline-none',
                collapsed && 'lg:justify-center lg:px-0'
              )}
              title={
                collapsed ? (profile?.full_name ?? t('defaultUser')) : undefined
              }
            >
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? t('defaultAvatar')}
                  />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    'U'}
                </AvatarFallback>
              </Avatar>
              <div className={cn('min-w-0 flex-1', collapsed && 'lg:hidden')}>
                <p className="text-foreground truncate text-sm font-medium">
                  {profile?.full_name ?? t('defaultUser')}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {profile?.email ?? ''}
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="bg-popover text-popover-foreground ring-border min-w-56"
            >
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                {t('menuProfile')}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                {t('menuSettings')}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                {t('menuSignOut')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
