import { expect, test } from 'claude-code/testing'

import { LEAVE_AFTER_MS, officeWithin } from './office'
import type { Desk } from './office'

// A sprite's frames animate their own visibility to "visible", which overrides a hidden parent:
// hiding a copy of an agent through visibility leaves it on screen (an agent stayed asleep at its
// desk while its walking copy went to the door). Copies of agents are hidden through opacity.
test('a departing agent: its seated and walking copies are switched by opacity, not visibility', () => {
  const now = 1_000_000
  const desk: Desk = {
    id: 'x',
    kind: 'claude',
    role: 'recherche',
    mood: 'rest',
    color: '#7fb069',
    name: 'Haiku',
    label: 'Lire math.js',
    arrivedAt: now - 60_000,
    endedAt: now - 1_000,
    seat: 0,
  }
  const { svg } = officeWithin({ desks: [desk], lead: { mood: 'rest', color: '#d97757' }, now, epoch: 0, freshMs: 10_000 })

  // The only visibility animations left are the sprite frame cycles (repeatCount="indefinite").
  const sets = svg.match(/<set attributeName="visibility"[^>]*>/g) ?? []
  expect(sets).toEqual([])
  const animates = svg.match(/<animate attributeName="visibility"[^>]*>/g) ?? []
  for (const a of animates) expect(a).toMatch(/repeatCount="indefinite"/)

  // The seated copy fades out, and the walking copy fades in, at the start of the departure.
  const start = ((desk.endedAt! + LEAVE_AFTER_MS - now) / 1000).toFixed(2)
  expect(svg).toContain(`<set attributeName="opacity" to="0" begin="${start}s" fill="freeze"/>`)
  expect(svg).toContain(`<g opacity="0"><set attributeName="opacity" to="1" begin="${start}s" fill="freeze"/>`)
})
