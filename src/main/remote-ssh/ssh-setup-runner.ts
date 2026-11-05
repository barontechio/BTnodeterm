// Native private-agent namespace, over the shared streaming setup runner.
import { appSshAgent } from './ssh-agent'
import { makeSshSetupRunner as makeCore } from '../../core/remote-ssh/ssh-setup-runner'
export * from '../../core/remote-ssh/ssh-setup-runner'

export function makeSshSetupRunner(resolve: Parameters<typeof makeCore>[0], opts?: Parameters<typeof makeCore>[1]): ReturnType<typeof makeCore> {
  return makeCore(resolve, { ...opts, agentEnv: opts?.agentEnv ?? (() => appSshAgent.env()) })
}
