import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Field } from './primitives'

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
