import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

/**
 * Keyboard behaviour for a role="radiogroup" of role="radio" buttons: arrows / Home / End move focus and
 * select (by clicking the radio). Give the checked radio tabIndex 0 and the others -1 (`radioTabIndex`).
 * After a radio is clicked, arrows are left alone: a pedal sending arrow keys must not change a control
 * that merely kept focus from a tap (it turns pages, or is being tested, instead).
 */
export function radioGroupProps() {
  return {
    role: 'radiogroup',
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      e.currentTarget.dataset.pointer = String(Date.now())
    },
    onFocus: (e: ReactFocusEvent<HTMLElement>) => {
      // Focus arriving from outside without a fresh pointer press (Tab) re-enables the arrows.
      const ds = e.currentTarget.dataset
      if (!e.currentTarget.contains(e.relatedTarget as Node | null) && Date.now() - Number(ds.pointer ?? 0) > 500) delete ds.pointer
    },
    onBlur: (e: ReactFocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) delete e.currentTarget.dataset.pointer
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.currentTarget.dataset.pointer !== undefined || e.altKey || e.ctrlKey || e.metaKey) return
      const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')].filter((r) => !(r as HTMLButtonElement).disabled)
      const at = radios.indexOf((e.target as HTMLElement).closest('[role="radio"]') as HTMLElement)
      if (at < 0) return
      const k = e.key
      const next =
        k === 'ArrowRight' || k === 'ArrowDown' ? (at + 1) % radios.length
        : k === 'ArrowLeft' || k === 'ArrowUp' ? (at - 1 + radios.length) % radios.length
        : k === 'Home' ? 0
        : k === 'End' ? radios.length - 1
        : -1
      if (next < 0) return
      e.preventDefault()
      e.stopPropagation()
      radios[next].focus()
      radios[next].click()
    },
  } as const
}

/** Roving tabindex: the checked radio (or the first, when none is) is the group's one Tab stop. */
export const radioTabIndex = (checked: boolean, index: number, anyChecked: boolean) => (checked || (!anyChecked && index === 0) ? 0 : -1)
