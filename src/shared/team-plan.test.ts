import { describe, expect, it } from 'vitest'
import { planVerification } from './team-plan'

describe('review task graph', () => {
  it('makes each lens wait for the actual target and the verdict wait for every reviewer', () => {
    const plan = planVerification({ targetId: 'work', targetTitle: 'Feature', agent: 'claude', shimPath: '/context.sh' })
    expect(plan.reviewers).toHaveLength(3)
    expect(plan.reviewers.map((r) => r.afterNodes)).toEqual([['work'], ['work'], ['work']])
    expect(plan.judge?.afterRoles).toEqual([0, 1, 2])
    expect(plan.judge?.afterNodes).toEqual([])
    expect(plan.roles).toHaveLength(4)
    expect(plan.reviewers[0].prompt).toContain('Do NOT change any files')
    expect(plan.reviewers[1].prompt).toContain('unsafe handling')
  })

  it('deduplicates lens names, preserves focus and omits the optional verdict', () => {
    const plan = planVerification({ targetId: 'work', targetTitle: 'Feature', agent: 'gemini', shimPath: '/context.sh',
      lenses: 'Security,security, accessibility', focus: 'Keyboard access', synthesis: 'off' })
    expect(plan.lenses).toEqual(['security', 'accessibility'])
    expect(plan.roles).toHaveLength(2)
    expect(plan.judge).toBeNull()
    expect(plan.reviewers.every((r) => r.prompt?.includes('Keyboard access'))).toBe(true)
  })
})
