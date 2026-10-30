import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readRegularFileNoFollow } from '../core/read-regular-file'
import { SshStore } from '../core/ssh-store'
import { SshFs } from '../core/ssh-fs'
import { OwnerLifetimes } from '../core/owner-lifetimes'
import { PassphrasePrompts, type PassphraseRecipient } from '../core/remote-ssh/passphrase-prompts'
import { AppSshAgent, agentSockPath } from '../core/remote-ssh/ssh-agent'
import { AskpassServer, ensureAskpassScript } from '../core/remote-ssh/ssh-askpass'
import { SshProjectManager } from '../core/remote-ssh/ssh-project'
import { parseSshArgv } from '../core/remote-ssh/native/ssh-argv'
import { isMuxControlCommand } from '../core/remote-ssh/ssh-child-gate'
import { makeSshProjectRunners, type ScopedSshProjectRunners } from '../core/remote-ssh/ssh-process-runners'
import { findSshBinary, setNativePassphrasePrompt, useNativeSsh } from '../core/remote-ssh/native/native-runtime'
import { hookServer } from '../core/agents/hook-server'
import { nodeIdsForCanvas, remoteNodeTokenMinter, setRemoteNodeTokenWriter } from '../core/agents/node-token-service'
import { setRemoteSessionEnvWriter } from '../core/remote-ssh/session-env'
import { IPC } from '../shared/ipc'
import type { CorePlatform } from '../core/platform'
import type { Settings, SshPassphraseRequest } from '../shared/types'
import { sshEndpointKey, type SshConnection, type SshServer } from '../shared/ssh'
import { remoteIntegrationPlan } from '../shared/agent-integrations'

export interface ServerSshProjects {
  readonly manager: SshProjectManager
  readonly fs: SshFs
  withQueuedExecutionCheck: ScopedSshProjectRunners['withQueuedExecutionCheck']
  refForProject(projectId: string): ReturnType<SshProjectManager['refForProject']>
  refForEndpoint(endpoint: Parameters<SshProjectManager['refForEndpoint']>[0]): ReturnType<SshProjectManager['refForEndpoint']>
  spawnRefFor(scopeId: string): ReturnType<SshProjectManager['spawnRefFor']>
  forgetClient(id: number): void
  close(): void
}

/** SSH runs under the server user's configured host context and remains off until opted in. */
export function registerServerSshProjects(deps: {
  platform: CorePlatform
  enabled: boolean
  settings(): Settings
  onConnected(projectId: string): Promise<void>
  projectTarget?(projectId: string): { server: SshConnection; remoteCwd: string } | null | undefined
  onIntegrationChange?(listener: () => void): (() => void) | void
  integrationReceipts?: { get(key: string): string | undefined; set(key: string, value: string | null): void }
}): ServerSshProjects {
  const { platform } = deps
  const owners = new OwnerLifetimes(); const prompts = new PassphrasePrompts(); const ready = new Map<number, string>()
  const inventory = new SshStore(path.join(platform.userDataDir, 'ssh-servers.json'))
  const agent = new AppSshAgent(undefined, agentSockPath(platform.userDataDir)); const askpass = new AskpassServer()
  const initiatingOwner = new AsyncLocalStorage<PassphraseRecipient | null>()
  const masterOwners = new Map<string, PassphraseRecipient | null>()
  let started: Promise<void> | null = null; let stopped = false; let script: string | undefined
  let connecting = 0
  const savedProjects = new Set<string>()
  const eligible = (id: number) => !stopped && platform.clientIds().includes(id) && platform.isOwnerClient?.(id) === true
  const recipient = (id: number): PassphraseRecipient | null => {
    const epoch = ready.get(id)
    if (!epoch || !eligible(id)) return null
    return { owner: owners.get(id, () => eligible(id) && ready.get(id) === epoch),
      request: (message) => { if (!eligible(id) || ready.get(id) !== epoch) return false; platform.sendTo(id, IPC.sshPassphraseRequest, message); return true },
      dismiss: (requestId) => { if (eligible(id) && ready.get(id) === epoch) platform.sendTo(id, IPC.sshPassphraseDismiss, { requestId }) } }
  }
  const fallbackRecipient = () => { for (const id of ready.keys()) { const current = recipient(id); if (current) return current } return null }
  const ask = (request: Omit<SshPassphraseRequest, 'requestId'>, owner?: PassphraseRecipient | null) => prompts.request(request, owner === undefined ? fallbackRecipient() : owner)
  const runners = makeSshProjectRunners({ userDataDir: platform.userDataDir, agent, askpass,
    getHook: () => ({ port: hookServer.getPort(), token: hookServer.getToken(), version: hookServer.getVersion() }),
    leadPaneWidth: () => deps.settings().tmuxLeadPaneWidth,
    captureExecutionCheck: (args) => {
      if (isMuxControlCommand(args)) return () => true
      let parsed: ReturnType<typeof parseSshArgv>
      try { parsed = parseSshArgv([...args]) } catch { return () => false }
      const cp = parsed.options.controlPath
      const project = manager.connectedHosts().find(({ projectId }) => manager.refForProject(projectId)?.controlPath === cp)?.projectId
      const generation = project ? manager.connectionKeyFor(project) : undefined
      return () => {
        if (!project || !generation || manager.connectionKeyFor(project) !== generation) return false
        const ref = manager.refForProject(project)
        if (!ref || ref.conn.host !== parsed.target.host || ref.conn.user !== parsed.target.user ||
          (ref.conn.port ?? 22) !== (parsed.target.port ?? 22)) return false
        try { checkTarget(project, ref.conn, ref.remoteCwd); return true } catch { return false }
      }
    },
    nodeIdsForProject: nodeIdsForCanvas, nodeTokenMinter: remoteNodeTokenMinter,
    // Agent tools are installed only under this host's existing integration consent.
    integrationsForHost: (host) => {
      const plan = remoteIntegrationPlan(deps.settings(), host)
      return { install: new Set(plan.install), remove: new Set(plan.remove), decided: plan.decided }
    },
    integrationReceipts: deps.integrationReceipts,
    // Build artifact, not a dependency on the native shell. Missing/unsafe bundles disable the
    // managed remote runtime through the manager's existing capability result.
    codexRelaySource: async () => (await readRegularFileNoFollow(path.join(__dirname, '../main/codex-relay.js'), 2 * 1024 * 1024)) ?? '',
    onStatus: (event) => {
      for (const id of platform.clientIds()) if (eligible(id)) { try { platform.sendTo(id, IPC.sshProjectStatus, event) } catch { /* departed UI */ } }
    }
  })
  const spawn = runners.spawnMaster
  runners.spawnMaster = (...args) => {
    const master = spawn(...args); const pid = master.pid?.(); const owner = initiatingOwner.getStore()
    if (pid && owner !== undefined) { masterOwners.set(String(pid), owner); master.on('exit', () => masterOwners.delete(String(pid))) }
    return master
  }
  // The helper path becomes available on lazy startup, before any master may spawn.
  const masterEnv = runners.masterEnvFor
  runners.masterEnvFor = (identity) => ({ ...masterEnv?.(identity), ...(script ? askpass.envFor(identity, script) : {}) })
  const manager = new SshProjectManager(runners)
  const unsubscribe = deps.onIntegrationChange?.(() => manager.onIntegrationConsentChanged())
  const remoteFs = new SshFs((args, stdin) => manager.sshRun(args, stdin))
  const start = (): Promise<void> => {
    if (stopped || !deps.enabled) return Promise.reject(new Error('ssh-disabled: enable NODETERM_SERVER_SSH on the host'))
    return started ??= (async () => {
      if (!useNativeSsh() && !findSshBinary()) throw new Error('ssh-unavailable: OpenSSH is not installed on the server')
      if (useNativeSsh()) setNativePassphrasePrompt(async (identityFile, request) =>
        (await ask({ identityFile, ...request }, initiatingOwner.getStore())) ?? null)
      else {
        script = await ensureAskpassScript(platform.userDataDir)
        if (stopped) throw new Error('ssh-stopped')
        await askpass.start()
        if (stopped) { askpass.stop(); throw new Error('ssh-stopped') }
      }
      askpass.setPromptHandler((request) => manager.isQuietMasterPid(request.caller) ? Promise.resolve(null) :
        ask({ ...request, target: manager.targetForMasterPid(request.caller) }, masterOwners.get(request.caller)))
      setRemoteNodeTokenWriter((controlPath, nodes) => { void manager.writeNodeTokenForNode(controlPath, nodes) })
      setRemoteSessionEnvWriter((controlPath, remotePath, content) => { void manager.writeSessionEnvFile(controlPath, remotePath, content) })
      manager.startWatchdog()
    })().catch((error) => { started = null; throw error })
  }
  const handle = (channel: string, operation: (id: number, ...args: any[]) => unknown, requiresTransport = true) => platform.handleWithSender(channel, (id, ...args) => {
    if (!eligible(id)) throw new Error('ssh-owner-required')
    if (requiresTransport && !deps.enabled) throw new Error('ssh-disabled: enable NODETERM_SERVER_SSH on the host')
    return operation(id, ...args)
  })
  platform.handleWithSender(IPC.sshProjectCapabilities, (id) => {
    if (!eligible(id)) throw new Error('ssh-owner-required')
    return { enabled: deps.enabled, filesystem: deps.enabled, transfers: false, media: false,
      transcriptAgents: deps.enabled ? ['claude'] : [], hostContext: 'server' }
  })
  const connection = (raw: SshConnection): SshConnection => {
    if (!raw || typeof raw.host !== 'string' || !raw.host || raw.host.length > 1024 || /[\s\0]/.test(raw.host) ||
      typeof raw.user !== 'string' || !raw.user || raw.user.length > 256 || /[\s\0@]/.test(raw.user) ||
      (raw.port !== undefined && (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535)) ||
      [raw.identityFile, raw.extraArgs].some((v) => v !== undefined && (typeof v !== 'string' || v.length > 16_384 || v.includes('\0')))) {
      throw new Error('ssh-invalid-connection')
    }
    return { host: raw.host, user: raw.user, port: raw.port, identityFile: raw.identityFile, extraArgs: raw.extraArgs }
  }
  const checkTarget = (project: string, target: SshConnection, cwd?: string) => {
    const saved = deps.projectTarget?.(project)
    if (saved !== undefined) savedProjects.add(project)
    if ((saved === undefined && savedProjects.has(project)) || saved === null || (saved && (sshEndpointKey(saved.server) !== sshEndpointKey(target) || saved.remoteCwd !== cwd))) {
      throw new Error('ssh-project-target-changed: reconnect using the saved project destination')
    }
  }
  const verifiedRef = (project: string) => {
    if (stopped || !deps.enabled) return undefined
    const value = manager.refForProject(project)
    if (!value) return undefined
    try { checkTarget(project, value.conn, value.remoteCwd); return value } catch { return undefined }
  }
  handle(IPC.sshList, () => inventory.list(), false)
  handle(IPC.sshSave, (_id, server: SshServer) => {
    const target = connection(server)
    if (typeof server.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(server.id) ||
      typeof server.label !== 'string' || server.label.length > 1024 ||
      (server.remoteCwd !== undefined && (typeof server.remoteCwd !== 'string' || server.remoteCwd.length > 4096 || server.remoteCwd.includes('\0')))) throw new Error('ssh-invalid-server')
    if (!inventory.list().some((s) => s.id === server.id) && inventory.list().length >= 256) throw new Error('ssh-inventory-full')
    return inventory.save({ ...target, id: server.id, label: server.label, ...(server.remoteCwd === undefined ? {} : { remoteCwd: server.remoteCwd }) })
  }, false)
  handle(IPC.sshDelete, (_id, id: string) => inventory.remove(id), false)
  handle(IPC.sshImport, () => inventory.importCandidates(), false)
  handle(IPC.sshPromptConnect, (id) => { owners.forget(id); const epoch = randomUUID(); ready.set(id, epoch); return epoch })
  handle(IPC.sshPromptDisconnect, (id, epoch: string) => { if (ready.get(id) === epoch) { owners.forget(id); ready.delete(id) } })
  handle(IPC.sshPassphraseSubmit, (id, requestId: string, value: string | null) => { const current = recipient(id); if (current) prompts.submit(current.owner, requestId, value) })
  handle(IPC.sshConnectProject, async (id, project: string, connectionInput: SshConnection, cwd?: string) => {
    if (typeof project !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(project)) throw new Error('ssh-invalid-project')
    const target = connection(connectionInput)
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length > 4096 || cwd.includes('\0'))) throw new Error('ssh-invalid-directory')
    target.execTrusted = inventory.list().some((saved) => sshEndpointKey(saved) === sshEndpointKey(target))
    checkTarget(project, target, cwd)
    if (connecting >= 8 || (!manager.refForProject(project) && manager.connectedHosts().length + connecting >= 32)) throw new Error('ssh-connect-busy')
    connecting++
    try {
      await start()
      if (!eligible(id)) throw new Error('ssh-owner-departed')
      checkTarget(project, target, cwd)
      const result = await initiatingOwner.run(recipient(id), () => manager.connect(project, target, cwd))
      try { checkTarget(project, target, cwd) } catch (error) { manager.disconnect(project, { final: true }); throw error }
      await deps.onConnected(project)
      return result
    } finally { connecting-- }
  })
  handle(IPC.sshDisconnectProject, (_id, project: string) => manager.disconnect(project, { final: true }))
  handle(IPC.sshKillSessions, (_id, project: string, nodes: string[], options?: { everySocket?: boolean }) => manager.killSessions(project, nodes, options))
  handle(IPC.sshListDir, (_id, project: string, directory: string) => manager.listDir(project, directory))
  handle(IPC.sshMkdir, (_id, project: string, directory: string) => manager.makeDir(project, directory))
  const ref = (project: string) => { const value = manager.refForProject(project); if (!value) throw new Error('ssh-project-disconnected'); checkTarget(project, value.conn, value.remoteCwd); return value }
  handle(IPC.sshFsList, (_id, project: string, directory: string) => remoteFs.listDir(ref(project), directory))
  handle(IPC.sshFsRead, (_id, project: string, file: string) => remoteFs.readText(ref(project), file))
  handle(IPC.sshFsReadBinary, (_id, project: string, file: string) => remoteFs.readBinary(ref(project), file))
  handle(IPC.sshFsWrite, (_id, project: string, file: string, text: string) => remoteFs.writeText(ref(project), file, text))
  handle(IPC.sshFsMkdir, (_id, project: string, directory: string) => remoteFs.mkdir(ref(project), directory))
  handle(IPC.sshFsExists, (_id, project: string, file: string) => remoteFs.exists(ref(project), file))
  handle(IPC.sshFsQuickOpen, (_id, project: string, directory: string) => remoteFs.listQuickOpenFiles(ref(project), directory))
  for (const channel of [IPC.sshUploadFile, IPC.sshDownloadFile, IPC.sshMediaAllow]) {
    handle(channel, () => { throw new Error('ssh-transfer-unavailable: this host does not yet provide browser SSH transfers or media') })
  }
  return { manager, fs: remoteFs, withQueuedExecutionCheck: runners.withQueuedExecutionCheck, refForProject: verifiedRef,
    refForEndpoint: (endpoint) => {
      const wanted = manager.refForEndpoint(endpoint)
      if (!wanted) return undefined
      for (const { projectId } of manager.connectedHosts()) {
        const current = verifiedRef(projectId)
        if (current?.controlPath === wanted.controlPath) return current
      }
      return undefined
    },
    spawnRefFor: (scopeId) => verifiedRef(scopeId) ? manager.spawnRefFor(scopeId) : undefined,
    forgetClient: (id) => { owners.forget(id); ready.delete(id) }, close: () => {
    if (stopped) return
    stopped = true; unsubscribe?.(); prompts.dispose(); owners.dispose(); ready.clear(); masterOwners.clear(); savedProjects.clear()
    if (started && useNativeSsh()) setNativePassphrasePrompt(null)
    manager.disconnectAll(); askpass.stop(); agent.stop()
  } }
}
