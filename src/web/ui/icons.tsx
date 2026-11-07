/**
 * Inline SVG icon set. 20 px viewBox, 1.5 px strokes, currentColor, so an icon
 * takes the color and size of the text around it. Decorative by default
 * (aria-hidden); pass a `title` when the icon carries meaning on its own.
 */
import type { ReactNode, SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  title?: string;
}

function make(name: string, paths: ReactNode) {
  function Icon({ size = 16, title, className, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={title ? undefined : true}
        role={title ? "img" : undefined}
        focusable="false"
        className={className ? `sl-icon ${className}` : "sl-icon"}
        {...rest}
      >
        {title ? <title>{title}</title> : null}
        {paths}
      </svg>
    );
  }
  Icon.displayName = `Icon${name}`;
  return Icon;
}

export const IconMenu = make("Menu", <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />);
export const IconSearch = make(
  "Search",
  <>
    <circle cx="8.75" cy="8.75" r="5.25" />
    <path d="m12.75 12.75 3.75 3.75" />
  </>,
);
export const IconChevronDown = make("ChevronDown", <path d="m5.5 8 4.5 4.5L14.5 8" />);
export const IconChevronRight = make("ChevronRight", <path d="m8 5.5 4.5 4.5L8 14.5" />);
export const IconClose = make("Close", <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />);
export const IconCheck = make("Check", <path d="m4.5 10.5 3.5 3.5 7.5-8" />);
export const IconCopy = make(
  "Copy",
  <>
    <rect x="7" y="7" width="9.5" height="9.5" rx="1.75" />
    <path d="M13 7V5.25A1.75 1.75 0 0 0 11.25 3.5h-5.5A2.25 2.25 0 0 0 3.5 5.75v5.5A1.75 1.75 0 0 0 5.25 13H7" />
  </>,
);
export const IconExternal = make(
  "External",
  <>
    <path d="M11.5 3.5h5v5M16.5 3.5 9.5 10.5" />
    <path d="M14.5 11.5v3.25a1.75 1.75 0 0 1-1.75 1.75h-7.5a1.75 1.75 0 0 1-1.75-1.75v-7.5A1.75 1.75 0 0 1 5.25 5.5H8.5" />
  </>,
);
export const IconUser = make(
  "User",
  <>
    <circle cx="10" cy="7" r="3.25" />
    <path d="M3.75 16.5c.9-2.9 3.3-4.5 6.25-4.5s5.35 1.6 6.25 4.5" />
  </>,
);
export const IconSun = make(
  "Sun",
  <>
    <circle cx="10" cy="10" r="3.25" />
    <path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06" />
  </>,
);
export const IconMoon = make("Moon", <path d="M16.25 12.1A6.5 6.5 0 0 1 7.9 3.75a6.5 6.5 0 1 0 8.35 8.35Z" />);
export const IconMonitor = make(
  "Monitor",
  <>
    <rect x="2.75" y="3.75" width="14.5" height="10" rx="1.75" />
    <path d="M7 16.75h6M10 13.75v3" />
  </>,
);
export const IconPlus = make("Plus", <path d="M10 4v12M4 10h12" />);
export const IconTrash = make(
  "Trash",
  <>
    <path d="M3.5 5.5h13M8 5.5V4.25c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75V5.5" />
    <path d="M5 5.5l.7 9.6a1.5 1.5 0 0 0 1.5 1.4h5.6a1.5 1.5 0 0 0 1.5-1.4l.7-9.6M8.25 8.75v4.75M11.75 8.75v4.75" />
  </>,
);
export const IconArrowLeft = make("ArrowLeft", <path d="M16 10H4.5M9 5.5 4.5 10 9 14.5" />);
export const IconBook = make(
  "Book",
  <>
    <path d="M10 5.25C8.6 4.1 6.6 3.5 3.5 3.5v11.25c3.1 0 5.1.6 6.5 1.75 1.4-1.15 3.4-1.75 6.5-1.75V3.5c-3.1 0-5.1.6-6.5 1.75Z" />
    <path d="M10 5.25V16.5" />
  </>,
);
export const IconSignOut = make(
  "SignOut",
  <>
    <path d="M8 16.5H5.25A1.75 1.75 0 0 1 3.5 14.75v-9.5A1.75 1.75 0 0 1 5.25 3.5H8" />
    <path d="M12.5 13.5 16 10l-3.5-3.5M16 10H8" />
  </>,
);

/** The product mark: a small rounded square with a speech notch. */
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false" className="sl-mark">
      <rect x="1.5" y="1.5" width="17" height="17" rx="5" fill="currentColor" />
      <path
        d="M12.9 7.6c-.5-.9-1.6-1.4-2.9-1.4-1.6 0-2.8.8-2.8 2 0 2.6 5.7 1.4 5.7 4.1 0 1.2-1.2 2.1-2.9 2.1-1.4 0-2.6-.6-3.1-1.6"
        fill="none"
        stroke="var(--sl-page-bg)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
