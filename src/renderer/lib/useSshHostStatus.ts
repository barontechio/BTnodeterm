import { useEffect, useState } from 'react'

/** Browser SSH belongs to the server host; native shells omit this capability negotiation. */
export function useSshHostStatus(): { available: boolean; message?: string } {
  const [status, setStatus] = useState<{ available: boolean; message?: string }>(() => ({
    available: !window.nodeTerminal.sshProject.capabilities
  }))
  useEffect(() => {
    const read = window.nodeTerminal.sshProject.capabilities
    if (!read) return
    let live = true
    void read().then((capability) => {
      if (live) setStatus(capability ? {
        available: capability.enabled,
        message: capability.enabled
          ? 'SSH uses the server’s keys, SSH configuration and file paths.'
          : 'SSH connections are disabled on this server. Enable NODETERM_SERVER_SSH on the host to connect.'
      } : { available: false, message: 'This server does not support SSH projects.' })
    }).catch((error) => {
      if (live) setStatus({ available: false, message: `Could not check SSH availability: ${error instanceof Error ? error.message : String(error)}` })
    })
    return () => { live = false }
  }, [])
  return status
}
