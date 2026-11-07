import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link } from "../lib/router";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { Avatar } from "./Display";
import { IconBook, IconClose, IconMenu, IconMonitor, IconMoon, IconSignOut, IconSun, Mark } from "./icons";
import { Menu, Popover } from "./Popover";
import { readThemePref, saveThemePref, type ThemePref } from "./theme";

const NAV_FOCUSABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";

export interface AppShellProps {
  /** Shown after the product name, e.g. "console". */
  product: string;
  /** Path the brand links to, inside the app. */
  homeTo?: string;
  search?: ReactNode;
  /** Right side of the top bar, before the user menu. */
  topActions?: ReactNode;
  user?: ReactNode;
  sidebar: ReactNode;
  /** Changes when the route changes; closes the mobile sidebar. */
  routeKey?: string;
  children: ReactNode;
}

/**
 * Top bar (48 px), sidebar (256 px) and content. At 768 px and below the
 * sidebar leaves the layout and opens as an overlay from the menu button.
 */
export function AppShell({ product, homeTo = "/", search, topActions, user, sidebar, routeKey, children }: AppShellProps) {
  const [navOpen, setNavOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setNavOpen(false), [routeKey]);

  useEffect(() => {
    if (navOpen) panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, [navOpen]);

  // While the overlay nav is open (phone width), keep focus inside it and the
  // menu button that closes it; Escape on the nav closes it. Handled on the nav
  // itself, so an Escape meant for a dialog or popover never reaches it.
  const onNavKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!navOpen) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      setNavOpen(false);
      menuBtn.current?.focus();
      return;
    }
    if (e.key !== "Tab") return;
    const els = [
      menuBtn.current,
      ...Array.from(panelRef.current?.querySelectorAll<HTMLElement>(NAV_FOCUSABLE) ?? []),
    ].filter((el): el is HTMLElement => !!el);
    // The menu button and the nav are apart in the DOM, so step through them
    // explicitly rather than letting Tab reach the rest of the top bar.
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length]!.focus();
  };

  return (
    <div className={cx("sl-shell", navOpen && "is-nav-open")}>
      <a className="sl-skip" href="#sl-main">
        Skip to content
      </a>
      <header className="sl-topbar">
        <div className="sl-topbar__start">
          <IconButton
            ref={menuBtn}
            label={navOpen ? "Close navigation" : "Open navigation"}
            className="sl-topbar__menu"
            aria-expanded={navOpen}
            aria-controls="sl-sidebar"
            onClick={() => setNavOpen((o) => !o)}
            onKeyDown={onNavKeyDown}
          >
            {navOpen ? <IconClose size={18} /> : <IconMenu size={18} />}
          </IconButton>
          <Link to={homeTo} className="sl-brand" aria-label={`slaude ${product}, home`}>
            <Mark size={18} />
            <span className="sl-brand__name">slaude</span>
            <span className="sl-brand__product">{product}</span>
          </Link>
        </div>
        <div className="sl-topbar__center">{search}</div>
        <div className="sl-topbar__end">
          {topActions}
          {user}
        </div>
      </header>
      <div className="sl-shell__body">
        <div className="sl-sidebar-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />
        <aside id="sl-sidebar" className="sl-sidebar" ref={panelRef} onKeyDown={onNavKeyDown}>
          {sidebar}
        </aside>
        <main id="sl-main" className="sl-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

export interface SidebarProps {
  title?: ReactNode;
  label: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Sidebar({ title, label, children, footer }: SidebarProps) {
  return (
    <div className="sl-sidebar__inner">
      {title && <div className="sl-sidebar__title">{title}</div>}
      <nav className="sl-sidebar__nav" aria-label={label}>
        <ul>{children}</ul>
      </nav>
      {footer && <div className="sl-sidebar__footer">{footer}</div>}
    </div>
  );
}

export interface NavItemProps {
  to: string;
  active?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

export function NavItem({ to, active, icon, children }: NavItemProps) {
  return (
    <li>
      <Link to={to} className={cx("sl-nav-item", active && "is-active")} aria-current={active ? "page" : undefined}>
        {icon && <span className="sl-nav-item__icon">{icon}</span>}
        <span className="sl-nav-item__label">{children}</span>
      </Link>
    </li>
  );
}

/** Top-bar link to the documentation site. Collapses to its icon on narrow screens. */
export function DocsLink({ href }: { href: string }) {
  return (
    <a className="sl-topbar__link" href={href} target="_blank" rel="noreferrer">
      <IconBook size={16} />
      <span className="sl-topbar__link-label">Documentation</span>
    </a>
  );
}

export interface UserMenuProps {
  /** Email or display name; null while loading. */
  name: string | null;
  /** Second line under the name, e.g. the console role. */
  detail?: string;
  onSignOut: () => void;
}

const THEMES: Array<{ value: ThemePref; label: string; Icon: typeof IconSun }> = [
  { value: "system", label: "System theme", Icon: IconMonitor },
  { value: "light", label: "Light theme", Icon: IconSun },
  { value: "dark", label: "Dark theme", Icon: IconMoon },
];

/** Avatar button opening identity, theme choice and sign out. */
export function UserMenu({ name, detail, onSignOut }: UserMenuProps) {
  const [theme, setTheme] = useState<ThemePref>(readThemePref);
  if (!name) return <span className="sl-avatar sl-avatar--md is-loading" aria-label="Loading account" />;
  return (
    <Popover
      kind="menu"
      align="end"
      trigger={(p) => (
        <button type="button" className="sl-user-btn" aria-label={`Account: ${name}`} {...p}>
          <Avatar name={name} />
        </button>
      )}
    >
      {(close) => (
        <Menu
          label="Account"
          onDone={close}
          header={
            <div className="sl-user-head">
              <Avatar name={name} />
              <div className="sl-user-head__text">
                <p className="sl-user-head__name">{name}</p>
                {detail && <p className="sl-user-head__detail">{detail}</p>}
              </div>
            </div>
          }
          items={[
            ...THEMES.map(({ value, label, Icon }) => ({
              key: value,
              label,
              icon: <Icon size={16} />,
              checked: theme === value,
              onSelect: () => {
                setTheme(value);
                saveThemePref(value);
              },
            })),
            {
              key: "signout",
              label: "Sign out",
              icon: <IconSignOut size={16} />,
              separatorBefore: true,
              onSelect: onSignOut,
            },
          ]}
        />
      )}
    </Popover>
  );
}
