/**
 * Minimal 16px line icons (1.5px stroke, currentColor). Purely decorative —
 * the owning button always carries a title / aria-label.
 */
import type { ReactNode } from 'react';

type IconProps = { size?: number; className?: string };

function Svg({ size = 14, className, children }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.76" />
    <path d="M13.3 2.6v3h-3" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3.3 3.3" />
  </Svg>
);

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 4 4 4-4 4" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Svg>
);

export const IconFit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3" />
  </Svg>
);

export const IconBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="3.75" r="1.5" />
    <circle cx="5" cy="12.25" r="1.5" />
    <circle cx="11" cy="5.25" r="1.5" />
    <path d="M5 5.25v5.5M11 6.75c0 2.5-2.5 2.75-6 4" />
  </Svg>
);

export const IconFiles = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 2.5h5l3 3v8H4z" />
    <path d="M9 2.5v3h3" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
);

export const IconArrowDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </Svg>
);

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
    <path d="M12 9.5v3.5H3V4h3.5" />
  </Svg>
);

export const IconPower = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2v6" />
    <path d="M4.6 4.4a5 5 0 1 0 6.8 0" />
  </Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Svg>
);

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
    <circle cx="6" cy="6.75" r="1" />
    <path d="m13.5 10.5-3-3-6 5" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 7.5v3M8 5.25v.01" />
  </Svg>
);

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.5M8 10.75v.01" />
  </Svg>
);

/** Context compaction: two arrows converging on a line. */
export const IconCompact = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2v4M5.5 4 8 6.25 10.5 4M8 14v-4M5.5 12 8 9.75 10.5 12M3 8h10" />
  </Svg>
);

/** Unknown / unrecognised event: dashed outline. */
export const IconUnknown = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5" strokeDasharray="2 2.2" />
  </Svg>
);

/** Brand mark for the empty state: three staggered execution spans. */
export const IconTraceMark = (p: IconProps) => (
  <svg className={`icon ${p.className ?? ''}`} width={p.size ?? 40} height={p.size ?? 40} viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false">
    <rect x="0.5" y="0.5" width="39" height="39" rx="9.5" stroke="currentColor" strokeOpacity="0.18" />
    <rect x="9" y="12" width="16" height="3" rx="1.5" fill="currentColor" fillOpacity="0.85" />
    <rect x="14" y="18.5" width="17" height="3" rx="1.5" fill="currentColor" fillOpacity="0.5" />
    <rect x="11" y="25" width="10" height="3" rx="1.5" fill="currentColor" fillOpacity="0.3" />
  </svg>
);
