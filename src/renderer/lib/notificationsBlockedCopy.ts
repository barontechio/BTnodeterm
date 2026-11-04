// Copy for Settings → Notifications' "the OS refused our notification" repair row. The button
// opens `notificationSettingsTarget(platform)` main-side (src/main/app-identity.ts), which exists
// on macOS and Windows only — so `button` is null exactly where that handler would open nothing.

export type CopyPlatform = 'mac' | 'windows' | 'other' | 'browser'

export function notificationsBlockedCopy(p: CopyPlatform): { message: string; button: string | null } {
  if (p === 'browser') return { message: 'Browser notifications are unavailable or blocked. Check this site’s notification permissions in your browser. Notifications require a supported browser, a secure connection and this page to stay open.', button: null }
  if (p === 'mac') return { message: 'macOS is blocking notifications for this app.', button: 'Open System Settings' }
  if (p === 'windows') return { message: 'Windows is blocking notifications for this app.', button: 'Open Notification settings' }
  return { message: 'The system is blocking notifications for this app.', button: null }
}
