import { describe, expect, it } from 'vitest'
import { settings } from '../state/settings'
import { applyStyle } from './ops'
import { useAnnotUI } from './store'
import { toolConfig } from './tools'

describe('applyStyle', () => {
  it('while re-editing a text, changes that text’s style and leaves the Text tool alone', () => {
    const before = toolConfig('text', settings().annotations.tools)
    useAnnotUI.setState({ selection: null, editing: { key: 'k', id: 't1', at: { x: 0.1, y: 0.1 }, style: { color: '#ff0000', bold: false, size: 20 } } })
    applyStyle({ bold: true })
    applyStyle({ color: '#00ff00' })
    expect(useAnnotUI.getState().editing?.style).toEqual({ color: '#00ff00', bold: true, size: 20 })
    expect(toolConfig('text', settings().annotations.tools)).toEqual(before)
    expect(settings().annotations.recentColors[0]).toBe('#00ff00')
    useAnnotUI.setState({ editing: null })
  })

  it('without a selection or an edited text, changes the current tool', () => {
    useAnnotUI.setState({ selection: null, editing: { key: 'k', at: { x: 0, y: 0 } } })
    const tool = settings().annotations.tool
    applyStyle({ opacity: 0.5 })
    expect(toolConfig(tool, settings().annotations.tools).opacity).toBe(0.5)
    useAnnotUI.setState({ editing: null })
  })
})
