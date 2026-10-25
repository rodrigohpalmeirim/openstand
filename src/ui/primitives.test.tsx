import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sheet } from '../library/editor/Sheet'
import { AskHost, confirmDialog, Dialog, Field, Menu, promptDialog, Segmented, Toggle, useMenu } from './primitives'

function Chips() {
  const [v, setV] = useState(['a', 'b', 'c'])
  return (
    <Field label="Artists">
      {v.map((x) => (
        <button key={x} type="button" aria-label={`Remove ${x}`} onClick={() => setV((p) => p.filter((y) => y !== x))} />
      ))}
      <input aria-label="Artists" />
    </Field>
  )
}

describe('Field', () => {
  it('does not press the first button when the caption is clicked', () => {
    const spy = vi.fn()
    render(
      <Field label="Rating">
        <button type="button" onClick={spy}>
          1
        </button>
      </Field>,
    )
    fireEvent.click(screen.getByText('Rating'))
    expect(spy).not.toHaveBeenCalled()
  })
  it('removing a chip button removes only that chip', () => {
    render(<Chips />)
    fireEvent.click(screen.getByLabelText('Remove a'))
    expect(screen.queryByLabelText('Remove a')).toBeNull()
    expect(screen.getByLabelText('Remove b')).toBeTruthy()
    expect(screen.getByLabelText('Remove c')).toBeTruthy()
  })
})

describe('dialogs have an accessible name', () => {
  afterEach(cleanup)

  it('Dialog is a modal dialog labelled by its title', () => {
    render(
      <Dialog open onClose={() => {}} title="Update storage keys">
        <p>body</p>
      </Dialog>,
    )
    const d = screen.getByRole('dialog', { name: 'Update storage keys' })
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe('Update storage keys')
  })

  it('Dialog without a title takes `label`', () => {
    render(
      <Dialog open onClose={() => {}} label="Welcome to OpenStand">
        <h2>Welcome to OpenStand</h2>
      </Dialog>,
    )
    expect(screen.getByRole('dialog', { name: 'Welcome to OpenStand' })).toBeTruthy()
  })

  it('two dialogs at once keep their own names', () => {
    render(
      <>
        <Dialog open onClose={() => {}} title="First">
          <p />
        </Dialog>
        <Dialog open onClose={() => {}} title="Second">
          <p />
        </Dialog>
      </>,
    )
    expect(screen.getByRole('dialog', { name: 'First' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Second' })).toBeTruthy()
  })

  it('confirm and prompt dialogs are named by their title', async () => {
    render(<AskHost />)
    let answer: Promise<boolean> | undefined
    act(() => void (answer = confirmDialog({ title: 'Stop syncing on this device?' })))
    const confirm = screen.getByRole('dialog', { name: 'Stop syncing on this device?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'OK' }))
    await expect(answer).resolves.toBe(true)
    act(() => void promptDialog({ title: 'Rename setlist', initial: 'Friday' }))
    expect(screen.getByRole('dialog', { name: 'Rename setlist' })).toBeTruthy()
  })

  it('Sheet is labelled by its title, with or without an explicit id', () => {
    render(
      <>
        <Sheet onClose={() => {}} title="Edit song">
          <p />
        </Sheet>
        <Sheet onClose={() => {}} title="Crop pages" labelledBy="crop-title">
          <p />
        </Sheet>
      </>,
    )
    expect(screen.getByRole('dialog', { name: 'Edit song' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Crop pages' }).getAttribute('aria-labelledby')).toBe('crop-title')
  })
})

describe('dialog focus and modality', () => {
  afterEach(cleanup)

  function Host() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Edit" footer={<button>Done</button>}>
          <input aria-label="Name" />
        </Dialog>
      </>
    )
  }

  it('focuses the dialog, makes the app inert, traps Tab and gives focus back on close', () => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
    render(<Host />, { container: root })
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    const d = screen.getByRole('dialog', { name: 'Edit' })
    expect(document.activeElement).toBe(d)
    expect(root.inert).toBe(true)

    const done = within(d).getByRole('button', { name: 'Done' })
    done.focus()
    fireEvent.keyDown(done, { key: 'Tab' })
    expect(document.activeElement).toBe(within(d).getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(done)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(root.inert).toBe(false)
    expect(document.activeElement).toBe(opener)
    root.remove()
  })

  it('Enter in a prompt answers it without the keypress reaching the button focus goes back to', async () => {
    const answers: (string | null)[] = []
    function Opener() {
      return <button onClick={() => void promptDialog({ title: 'Go to page', initial: '1' }).then((v) => answers.push(v))}>Go to page</button>
    }
    render(
      <>
        <Opener />
        <AskHost />
      </>,
    )
    const opener = screen.getByRole('button', { name: 'Go to page' })
    opener.focus()
    fireEvent.click(opener)
    const field = within(screen.getByRole('dialog', { name: 'Go to page' })).getByRole('textbox')
    fireEvent.change(field, { target: { value: '7' } })
    // fireEvent returns false when the default action (the keypress, a click on a focused button) was cancelled.
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false)
    await act(() => Promise.resolve())
    expect(answers).toEqual(['7'])
    expect(screen.queryByRole('dialog')).toBeNull()
    // Focus goes back only once the key is done, so the same Enter can't press the opener again.
    expect(document.activeElement).not.toBe(opener)
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(document.activeElement).toBe(opener)
  })

  it('a prompt opened with Enter keeps focus in its field (StrictMode re-runs the focus effect)', async () => {
    render(
      <StrictMode>
        <button onClick={() => void promptDialog({ title: 'Rename layer', initial: 'Top' })}>Rename</button>
        <AskHost />
      </StrictMode>,
    )
    const opener = screen.getByRole('button', { name: 'Rename' })
    opener.focus()
    fireEvent.keyDown(opener, { key: 'Enter' })
    fireEvent.click(opener) // what the browser does with the keypress
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(document.activeElement).toBe(within(screen.getByRole('dialog', { name: 'Rename layer' })).getByRole('textbox'))
  })

  it('escapeCloses={false} keeps the dialog open on Escape; backdropCloses={false} ignores backdrop taps', () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} label="Welcome" escapeCloses={false} backdropCloses={false}>
        <p />
      </Dialog>,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerDown(screen.getByRole('dialog').parentElement!)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('keyboard', () => {
  afterEach(cleanup)

  it('Segmented is a labelled radio group with one Tab stop and arrow keys', () => {
    function Seg() {
      const [v, setV] = useState('b')
      return <Segmented label="Fit" value={v} onChange={setV} options={['a', 'b', 'c'].map((x) => ({ value: x, label: x }))} />
    }
    render(<Seg />)
    const group = screen.getByRole('radiogroup', { name: 'Fit' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1])
    radios[1].focus()
    fireEvent.keyDown(radios[1], { key: 'ArrowRight' })
    expect(radios[2].getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(radios[2])
    fireEvent.keyDown(radios[2], { key: 'ArrowRight' }) // wraps
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(radios[0], { key: 'End' })
    expect(radios[2].getAttribute('aria-checked')).toBe('true')
  })

  it('arrow keys leave a radio group alone after it was tapped (a pedal must not change it)', () => {
    const onChange = vi.fn()
    render(<Segmented label="When" value="tap" onChange={onChange} options={[{ value: 'tap', label: 'Press' }, { value: 'hold', label: 'Hold' }]} />)
    const group = screen.getByRole('radiogroup', { name: 'When' })
    const press = within(group).getByRole('radio', { name: 'Press' })
    fireEvent.pointerDown(press)
    press.focus()
    fireEvent.keyDown(press, { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Menu focuses its first item, moves with arrows and returns focus to its button on Escape', () => {
    function M() {
      const { ref, anchor, open, toggle, close } = useMenu()
      return (
        <>
          <button ref={ref} onClick={toggle}>
            More
          </button>
          <Menu anchor={anchor} open={open} onClose={close} items={[{ label: 'One' }, { label: 'Two', disabled: true }, { label: 'Three' }]} />
        </>
      )
    }
    render(<M />)
    const btn = screen.getByRole('button', { name: 'More' })
    btn.focus()
    fireEvent.click(btn)
    const [one, , three] = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(one)
    fireEvent.keyDown(one, { key: 'ArrowDown' }) // skips the disabled item
    expect(document.activeElement).toBe(three)
    fireEvent.keyDown(three, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(one)
    fireEvent.keyDown(one, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(three)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('an unlabelled Toggle takes the caption beside it as its name', () => {
    render(
      <div>
        <span>Night mode</span>
        <Toggle checked={false} onChange={() => {}} />
      </div>,
    )
    expect(screen.getByRole('switch', { name: 'Night mode' })).toBeTruthy()
  })
})
