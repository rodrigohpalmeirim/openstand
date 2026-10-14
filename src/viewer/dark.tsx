import { cx, Popover, type MenuItem } from '../ui/primitives'

/**
 * The viewer is always dark, but theme tokens resolve at :root, so a nested `.dark` class does
 * not re-theme primitives. Re-declare the colour tokens for popover content instead.
 */
export const DARK_VARS = {
  '--color-bg': '#0f1011',
  '--color-surface': '#17181a',
  '--color-surface-2': '#1e1f22',
  '--color-surface-3': '#2a2b2f',
  '--color-line': '#2c2d31',
  '--color-fg': '#ecebe8',
  '--color-muted': '#a09d96',
  '--color-faint': '#6f6c66',
  colorScheme: 'dark',
} as React.CSSProperties

export function DarkPop({ className, children, ...rest }: Omit<React.ComponentProps<typeof Popover>, 'className'> & { className?: string }) {
  return (
    <Popover {...rest} className={cx('border-[#2c2d31]! bg-[#17181a]! text-[#ecebe8]!', className)}>
      <div style={DARK_VARS}>{children}</div>
    </Popover>
  )
}

/** `Menu` for the performance view: dark in either app theme, finger-sized rows on touch screens. */
export function DarkMenu({ items, ...rest }: Omit<React.ComponentProps<typeof Popover>, 'children' | 'className'> & { items: MenuItem[] }) {
  return (
    <DarkPop {...rest} className="min-w-56">
      <div role="menu">
        {items.map((it, i) =>
          it.divider ? (
            <div key={i} className="my-1 h-px bg-white/10" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                rest.onClose()
                it.onSelect?.()
              }}
              className={cx(
                'flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition hover:bg-white/10 disabled:opacity-40 pointer-coarse:min-h-11',
                it.danger && 'text-danger',
              )}
            >
              <span className="flex size-4 items-center justify-center text-white/55">{it.icon}</span>
              <span className="flex-1">{it.label}</span>
              {it.hint && <span className="text-xs text-white/40">{it.hint}</span>}
            </button>
          ),
        )}
      </div>
    </DarkPop>
  )
}
