// Compatibility adapter; the server and helper script live in the shared core.
import { AskpassServer } from '../../core/remote-ssh/ssh-askpass'
export * from '../../core/remote-ssh/ssh-askpass'
export const askpassServer = new AskpassServer()
