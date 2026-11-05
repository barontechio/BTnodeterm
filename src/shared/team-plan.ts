import { parseLenses, verifyLensPrompt, verifySynthesisPrompt } from './verify-panel'
import type { TeamRole } from './team-spec'

export interface PlannedTeamRole extends TeamRole {
  /** Existing stations this member waits for and reads. */
  afterNodes: string[]
  /** Other members, by plan index, this member waits for and reads. */
  afterRoles: number[]
}

export interface PlannedReviewRole extends PlannedTeamRole {
  title: string
  prompt: string
}

/** A review's task graph and briefs, independent of node allocation, storage and execution. */
export function planVerification(input: {
  targetId: string; targetTitle: string; agent: string; shimPath: string; hostPlatform?: string
  lenses?: string; focus?: string; synthesis?: string
}): { lenses: string[]; reviewers: PlannedReviewRole[]; judge: PlannedReviewRole | null; roles: PlannedReviewRole[] } {
  const lenses = parseLenses(input.lenses)
  const reviewers = lenses.map((lens): PlannedReviewRole => ({
    title: `Verify: ${lens}`, agent: input.agent,
    prompt: verifyLensPrompt({ lens, targetTitle: input.targetTitle, targetId: input.targetId,
      agentId: input.agent, shimPath: input.shimPath, hostPlatform: input.hostPlatform, focus: input.focus }),
    afterNodes: [input.targetId], afterRoles: []
  }))
  const judge: PlannedReviewRole | null = (input.synthesis ?? 'on').trim().toLowerCase() === 'off' ? null : {
    title: 'Verify: verdict', agent: input.agent,
    prompt: verifySynthesisPrompt({ lenses, targetTitle: input.targetTitle, agentId: input.agent,
      shimPath: input.shimPath, hostPlatform: input.hostPlatform }),
    afterNodes: [], afterRoles: reviewers.map((_, i) => i)
  }
  return { lenses, reviewers, judge, roles: [...reviewers, ...(judge ? [judge] : [])] }
}

/** Teams start independently; their shared conductor is linked during materialization. */
export function planIndependentTeam(roles: readonly TeamRole[]): PlannedTeamRole[] {
  return roles.map((role) => ({ ...role, afterNodes: [], afterRoles: [] }))
}
