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

test('office: each desk shows its exact model on a plate, and the lead its session model', () => {
  const now = 2_000_000
  const desks: Desk[] = [
    { id: 'n', kind: 'gemini', role: 'verification', mood: 'busy', color: '#e85dd8', name: 'Gemini Neon (low)', label: 'Revue', model: 'gemini-4-neon-low', arrivedAt: now - 60_000, seat: 0 },
    { id: 's', kind: 'claude', role: 'creation', mood: 'busy', color: '#e0a84e', name: 'Sonnet 5.5', label: 'Code', model: 'claude-sonnet-5-5', arrivedAt: now - 50_000, seat: 1 },
  ]
  const { svg } = officeWithin({ desks, lead: { mood: 'busy', color: '#d97757', model: 'claude-fable-5-2' }, now, epoch: 0, freshMs: 10_000 })
  expect(svg).toContain('>gemini-4-neon-low</text>')
  expect(svg).toContain('>claude-sonnet-5-5</text>')
  expect(svg).toContain('>claude-fable-5-2</text>')
  expect((svg.match(/class="model-plate"/g) ?? []).length).toBe(3)
  // Without a known lead model, the plate keeps its title alone.
  const plain = officeWithin({ desks, lead: { mood: 'rest', color: '#d97757' }, now, epoch: 0, freshMs: 10_000 }).svg
  expect(plain).toContain('CHEF DE PROJET')
  expect(plain).not.toContain('claude-fable-5-2')
})

test('office: 30 desks that all carry a model plate still fit the budget, none hidden', () => {
  const now = 3_000_000
  const desks: Desk[] = Array.from({ length: 30 }, (_, i) => ({
    id: `d${i}`,
    kind: i % 2 ? 'gemini' : 'claude',
    role: (['verification', 'recherche', 'creation', 'architecte', 'orchestrateur', 'generaliste'] as const)[i % 6]!,
    mood: i % 3 ? 'busy' : 'rest',
    color: '#4f8df7',
    name: `Agent ${i}`,
    label: `Tâche numéro ${i} assez longue`,
    model: i % 2 ? 'gemini-4-hydrogen-xhigh' : 'claude-sonnet-5-5',
    arrivedAt: now - 100_000 + i * 1000,
    seat: i,
  }))
  const r = officeWithin({ desks, lead: { mood: 'busy', color: '#d97757', model: 'claude-opus-5-5' }, now, epoch: 0, freshMs: 10_000 })
  expect(r.hidden).toBe(0)
  expect(r.svg.length).toBeLessThanOrEqual(125_000)
})
