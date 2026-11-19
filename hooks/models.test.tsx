import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'progress-board',
  component: 'Pane',
  requestId: 'progress-board',
  props: { title: 'Avancement', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the board names Gemini Neon, not Flash', async ($, on) => {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: '[gemini: agy gemini-4-neon-low]\nok' }))
  on('clock.now', () => ({ value: 1000 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ask-gemini --task review --model gemini-4-neon-low "x"', description: 'Revue Neon' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(text).toMatch(/Gemini Neon \(low\)/)
  expect(text).not.toMatch(/Gemini Flash/)
  await ui.unmount()
})
