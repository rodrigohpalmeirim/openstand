import { describe, expect, it } from 'vitest'
import { pageSpeed, scrollSeconds, stepFactor, stripSpeed, turnInterval } from './math'

describe('auto-scroll maths', () => {
  it('plans the song duration minus the start delay, defaulting to 3 minutes', () => {
    expect(scrollSeconds(200, 5)).toBe(195)
    expect(scrollSeconds(0, 5)).toBe(175)
    expect(scrollSeconds(8, 5)).toBe(10)
  })

  it('scrolls a strip so the whole distance takes the planned time', () => {
    expect(stripSpeed({ mode: 'duration', speed: 30 }, 6000, 200)).toBe(30)
    expect(stripSpeed({ mode: 'duration', speed: 30 }, 6000, 200, 2)).toBe(60)
    expect(stripSpeed({ mode: 'speed', speed: 42 }, 6000, 200)).toBe(42)
  })

  it('gives each page an equal share of the time after page-end pauses', () => {
    // 4 pages, 100 s, 2 s pause between pages → (100 - 6) / 4 = 23.5 s per page
    expect(pageSpeed({ mode: 'duration', speed: 30, pageDelay: 2 }, 470, 4, 100)).toBeCloseTo(20)
    expect(pageSpeed({ mode: 'speed', speed: 25, pageDelay: 2 }, 470, 4, 100)).toBe(25)
  })

  it('times page turns for views that cannot scroll', () => {
    expect(turnInterval({ mode: 'duration', speed: 30 }, 4, 120, 800)).toBe(30)
    expect(turnInterval({ mode: 'duration', speed: 30 }, 4, 120, 800, 1.5)).toBe(20)
    expect(turnInterval({ mode: 'speed', speed: 40 }, 4, 120, 800)).toBe(20)
  })

  it('steps the speed factor within bounds', () => {
    expect(stepFactor(1, 1)).toBe(1.15)
    expect(stepFactor(1, -1)).toBe(0.87)
    expect(stepFactor(4, 1)).toBe(4)
    expect(stepFactor(0.25, -1)).toBe(0.25)
  })
})
