import { REPORT_ISSUE_CONTROL_REFUSAL } from '../agents/hook-server'
import { dryRunRequested } from '../../shared/control-verbs'
import { reportIssue, type ReportIssueDeps } from './report-issue-service'

const reporting = new Set<string>()
const FLAGS = new Set(['kind', 'title', 'body', 'output', 'agent', 'dry-run'])

/** The same verified, own-project entrance on both hosts. Consent stays in reportIssue. */
export async function reportIssueFromControl(request: { nodeId: string; args: Record<string, string>; verified: boolean }, deps: {
  projectIdsForNode(nodeId: string): readonly string[]
  service: ReportIssueDeps
}): Promise<{ ok: boolean; message?: string; error?: string }> {
  const refuse = (error: string) => ({ ok: false, error, message: error })
  if (!request.verified) return refuse(REPORT_ISSUE_CONTROL_REFUSAL)
  const unknown = Object.keys(request.args).find((flag) => !FLAGS.has(flag))
  if (unknown) return refuse(`report-flag-unsupported: --${unknown} is not supported; nothing was published.`)
  const ids = deps.projectIdsForNode(request.nodeId)
  if (ids.length !== 1) return refuse('report-no-project: this node must belong to exactly one saved project to report to its repository. Do not retry.')
  const projectId = ids[0]
  // Refuse overlap rather than queue a publication after its caller has timed out.
  if (reporting.has(projectId)) return refuse('report-busy: another report for this project is in progress; wait for its outcome before reporting again.')
  reporting.add(projectId)
  try {
    const args = request.args
    const result = await reportIssue(deps.service, { projectId, dryRun: dryRunRequested(args), input: {
      kind: args.kind ?? '', title: args.title ?? '', detail: args.body ?? '',
      ...(args.output ? { excerpt: args.output } : {}), ...(args.agent ? { agent: args.agent } : {})
    } })
    return result.ok ? { ok: true, message: result.action === 'dry-run' && result.preview ?
      `${result.message}\n\n${result.preview}` : result.message } : { ok: false, error: result.error, message: result.message }
  } finally { reporting.delete(projectId) }
}
