import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChipInput } from './ChipInput'

afterEach(cleanup)

function typeAndEnter(text: string, props: Partial<Parameters<typeof ChipInput>[0]> = {}) {
  cleanup()
  const onChange = vi.fn()
  render(<ChipInput aria-label="Values" value={[]} onChange={onChange} {...props} />)
  const input = screen.getByRole('combobox')
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
  return onChange
}

describe('ChipInput', () => {
  it('commits an exact suggestion rather than a longer one that starts with it', () => {
    expect(typeAndEnter('Bb', { suggestions: ['A', 'Bb', 'Bbm', 'C'] })).toHaveBeenCalledWith(['Bb'])
    expect(typeAndEnter('bb', { suggestions: ['Bb', 'Bbm'] })).toHaveBeenCalledWith(['Bb'])
  })

  it('still takes the existing spelling of a single partial match', () => {
    expect(typeAndEnter('beat', { suggestions: ['The Beatles', 'Queen'] })).toHaveBeenCalledWith(['The Beatles'])
  })

  it('capitalises only when asked', () => {
    expect(typeAndEnter('jazz')).toHaveBeenCalledWith(['jazz'])
    expect(typeAndEnter('jazz', { capitalize: true })).toHaveBeenCalledWith(['Jazz'])
  })
})
