import { platform } from './platform'
import { IPC } from '../shared/ipc'
import {
  controlCapabilities,
  controlCapabilitiesText,
  type ControlCapabilityReport,
  type ControlEdition
} from '../shared/control-capabilities'

export function registerControlCapabilities(
  edition: ControlEdition,
  enabled: () => boolean
): () => ControlCapabilityReport {
  const read = () => controlCapabilities(edition, enabled())
  platform().handle(IPC.controlCapabilities, read)
  return read
}

export function controlCapabilitiesReply(
  report: ControlCapabilityReport,
  args: Record<string, string>,
  verified: boolean
): { ok: boolean; error?: string; message?: string; result?: ControlCapabilityReport } {
  if (!verified) return { ok: false, error: 'capabilities-identity-refused: verified node identity is required' }
  const unknown = Object.keys(args)[0]
  if (unknown) return { ok: false, error: `capabilities: unknown flag --${unknown}` }
  return { ok: true, message: controlCapabilitiesText(report), result: report }
}
