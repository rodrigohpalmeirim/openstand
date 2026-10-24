import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sheet } from '../library/editor/Sheet'
import { AskHost, confirmDialog, Dialog, Field, promptDialog } from './primitives'

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
