import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { CheckboxCheckedIcon, CheckboxIcon } from './icons'

/** Small shared controls for the phone surface. All labels come from `t()`. */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'primary',
  busy = false,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  busy?: boolean
}) {
  return (
    <button
      type="button"
      className={`btn btn--${variant}${className ? ` ${className}` : ''}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  )
}

export function Field(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props
  return <input className={`field${className ? ` ${className}` : ''}`} {...rest} />
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = props
  return <textarea className={`field field--multiline${className ? ` ${className}` : ''}`} {...rest} />
}

export function ScreenHeader({ title, back }: { title: string; back?: ReactNode }) {
  return (
    <header className="phone__header">
      {back ?? <span />}
      <h1 className="phone__title">{title}</h1>
      <span />
    </header>
  )
}

export function Avatar({ title }: { title: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {title.trim().slice(0, 1)}
    </span>
  )
}

export function Checkbox({ checked }: { checked: boolean }) {
  return checked ? (
    <CheckboxCheckedIcon size={24} aria-hidden="true" />
  ) : (
    <CheckboxIcon size={24} aria-hidden="true" />
  )
}

export function EmptyState({
  icon,
  title,
  body,
}: {
  icon: ReactNode
  title: string
  body: string
}) {
  return (
    <div className="empty">
      <span className="empty__icon">{icon}</span>
      <p className="h-medium">{title}</p>
      <p className="body dim">{body}</p>
    </div>
  )
}

export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton" key={i}>
          <span className="skeleton__avatar" />
          <span className="skeleton__body">
            <span className="skeleton__line" />
            <span className="skeleton__line skeleton__line--short" />
          </span>
        </div>
      ))}
    </div>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  name,
}: {
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (next: T) => void
  name: string
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          name={name}
          aria-checked={option.value === value}
          className="seg__btn"
          onClick={() => {
            if (option.value !== value) onChange(option.value)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Bottom sheet: overlay SC-1st, sheet on the page background, title centred
 * (official popup shape). Escape and a tap on the overlay close it; focus goes
 * to the first button so a keyboard user is not left behind the overlay.
 */
export function Sheet({
  title,
  body,
  children,
  onClose,
}: {
  title: string
  body?: string
  children: ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const first = ref.current?.querySelector<HTMLElement>('button')
    first?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="sheet__title">{title}</h2>
        {body ? <p className="sheet__body">{body}</p> : null}
        <div className="stack">{children}</div>
      </div>
    </div>
  )
}

/** One toast at a time; the hook lives in `useToast.ts`. */
export function Toast({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="toast" role="status" aria-live="polite">
      {message}
    </div>
  )
}
