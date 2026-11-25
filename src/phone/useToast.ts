import { useEffect, useRef, useState } from 'react'

/**
 * One toast at a time; a new message replaces the old one. Lives apart from
 * `components.tsx` so that file only exports components (Fast Refresh).
 */
export function useToast(): { message: string | null; show: (text: string) => void } {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const show = (text: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    setMessage(text)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setMessage(null)
    }, 2400)
  }

  return { message, show }
}
