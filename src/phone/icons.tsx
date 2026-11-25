import type { ReactNode, SVGProps } from 'react'

/**
 * Pixel-art icons from the official Even icon set, shipped with the toolkit
 * (`even-toolkit/web/icons/svg`, MIT). Copied as-is except `fill` → `currentColor`
 * so one icon serves both the active and the inactive tab. No redrawing:
 * 32×32 grid, 2 px step, same shapes as other Even apps.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

function Glyph({ size = 24, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** chat bubble — feat-message */
export function ChatsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M5 31H3V29H5V31ZM7 29H5V27H7V29ZM5 27H3V5H5V27ZM9 27H7V25H9V27ZM27 25H9V23H27V25ZM29 5V23H27V5H29ZM23 18H9V16H23V18ZM23 12H9V10H23V12ZM27 5H5V3H27V5Z"
        fill="currentColor"
      />
    </Glyph>
  )
}

/** assistant — feat-even-ai */
export function AgentIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M17 30H15V2H17V30ZM10.5 24H8.5V8H10.5V24ZM23.5 24H21.5V8H23.5V24ZM4 20H2V12H4V20ZM30 20H28V12H30V20Z"
        fill="currentColor"
      />
    </Glyph>
  )
}

/** gear — menu-gear */
export function SettingsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M15 28H17V25H19V29H17V30H15V29H13V25H15V28ZM9 22H8V23H7V24H8V25H9V24H10V23H13V25H11V26H9V27H7V26H6V25H5V23H6V21H7V19H9V22ZM22 24H23V25H24V24H25V23H24V22H23V19H25V21H26V23H27V25H26V26H25V27H23V26H21V25H19V23H22V24ZM19 21H13V19H19V21ZM7 15H4V17H7V19H3V17H2V15H3V13H7V15ZM13 19H11V13H13V19ZM21 19H19V13H21V19ZM29 15H30V17H29V19H25V17H28V15H25V13H29V15ZM9 6H11V7H13V9H10V8H9V7H8V8H7V9H8V10H9V13H7V11H6V9H5V7H6V6H7V5H9V6ZM19 13H13V11H19V13ZM25 6H26V7H27V9H26V11H25V13H23V10H24V9H25V8H24V7H23V8H22V9H19V7H21V6H23V5H25V6ZM17 3H19V7H17V4H15V7H13V3H15V2H17V3Z"
        fill="currentColor"
      />
    </Glyph>
  )
}

/** chevron left — guide-chevron-small-back */
export function BackIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M11 29H9V27H11V29ZM13 27H11V25H13V27ZM15 25H13V23H15V25ZM17 23H15V21H17V23ZM19 21H17V19H19V21ZM21 19H19V17H21V19ZM23 15V17H21V15H23ZM21 15H19V13H21V15ZM19 13H17V11H19V13ZM17 11H15V9H17V11ZM15 9H13V7H15V9ZM13 7H11V5H13V7ZM11 5H9V3H11V5Z"
        fill="currentColor"
      />
    </Glyph>
  )
}

/** search — guide-search */
export function SearchIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M27 27H24V24H27V27ZM24 24H21V21H24V24ZM21 21H18V18H21V21ZM16 20H9V18H16V20ZM9 18H7V16H9V18ZM18 18H16V16H18V18ZM7 16H5V9H7V16ZM20 16H18V9H20V16ZM9 9H7V7H9V9ZM18 9H16V7H18V9ZM16 7H9V5H16V7Z"
        fill="currentColor"
      />
    </Glyph>
  )
}

/** check — status-checkmark */
export function CheckIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M13 24H11V22H13V24ZM11 22H9V20H11V22ZM15 22H13V20H15V22ZM9 20H7V18H9V20ZM17 20H15V18H17V20ZM7 18H5V16H7V18ZM19 18H17V16H19V18ZM21 16H19V14H21V16ZM23 14H21V12H23V14ZM25 12H23V10H25V12ZM27 10H25V8H27V10Z"
        fill="currentColor"
      />
    </Glyph>
  )
}

/** unchecked box — status-checkbox */
export function CheckboxIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M23 25H9V23H23V25ZM9 23H7V9H9V23ZM25 23H23V9H25V23ZM23 9H9V7H23V9Z"
        fill="currentColor"
      />
    </Glyph>
  )
}

/** checked box — status-selected-box */
export function CheckboxCheckedIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M26 6H28V26H26V28H6V26H4V6H6V4H26V6ZM22 13H20V15H18V17H16V19H14V21H12V19H10V17H8V19H10V21H12V23H14V21H16V19H18V17H20V15H22V13H24V11H22V13Z"
        fill="currentColor"
      />
    </Glyph>
  )
}

/** close — edit-cross */
export function CloseIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M5 29H3V27H5V29ZM29 29H27V27H29V29ZM7 27H5V25H7V27ZM27 27H25V25H27V27ZM9 25H7V23H9V25ZM25 25H23V23H25V25ZM11 23H9V21H11V23ZM23 23H21V21H23V23ZM13 21H11V19H13V21ZM21 21H19V19H21V21ZM15 19H13V17H15V19ZM19 19H17V17H19V19ZM15 15H13V13H15V15ZM19 15H17V13H19V15ZM13 13H11V11H13V13ZM21 13H19V11H21V13ZM11 11H9V9H11V11ZM23 11H21V9H23V11ZM9 9H7V7H9V9ZM25 9H23V7H25V9ZM7 7H5V5H7V7ZM27 7H25V5H27V7ZM5 3V5H3V3H5ZM29 5H27V3H29V5Z"
        fill="currentColor"
      />
    </Glyph>
  )
}

/** lock — feat-privacy */
export function PrivacyIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M18 31H14V29H18V31ZM14 29H11V27H14V29ZM21 29H18V27H21V29ZM11 27H9V25H11V27ZM23 27H21V25H23V27ZM9 25H7V22H9V25ZM25 25H23V22H25V25ZM7 22H5V19H7V22ZM18.5 18H17V22H15V18H13.5V16H18.5V18ZM27 22H25V19H27V22ZM5 19H3V7H5V19ZM29 19H27V7H29V19ZM13.5 16H11.5V11H13.5V16ZM20.5 16H18.5V11H20.5V16ZM18.5 11H13.5V9H18.5V11ZM8 7H5V5H8V7ZM27 7H24V5H27V7ZM12 5H8V3H12V5ZM24 5H20V3H24V5ZM20 3H12V1H20V3Z"
        fill="currentColor"
      />
    </Glyph>
  )
}
