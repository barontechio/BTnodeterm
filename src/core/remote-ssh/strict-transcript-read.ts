import { posixQuote } from '../../shared/ssh'
import { CHAT_PAGE_MAX_BYTES } from '../../shared/chat-page'
import { SESSION_ID_RE } from '../transcript-reader'
import { isSafeAccountId } from '../claude-accounts-core'

const ACCOUNT_ID_MAX = 128
const DIRECTORY_LIMIT = 4096

// Optional remote Python 3 helper. No installation or host files: one bounded, read-only exec.
// Directory-relative opens keep every account/project component behind NOFOLLOW. The named
// identities are checked again after the read; error output never includes paths or file data.
export const STRICT_TRANSCRIPT_PYTHON = String.raw`import os, sys, stat, json, base64, errno, contextlib, re
class Unsafe(Exception): pass
def main():
    home, account, session, limit, before = sys.argv[1:]
    limit = int(limit); before = int(before)
    if not all(hasattr(os, flag) for flag in ('O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK')) or os.open not in os.supports_dir_fd or os.scandir not in os.supports_fd:
        return 69
    if not re.fullmatch(r'[A-Za-z0-9_-]+', session) or limit < 1 or limit > ${CHAT_PAGE_MAX_BYTES} or before < -1:
        return 65
    if account and not re.fullmatch(r'[A-Za-z0-9_-]{1,${ACCOUNT_ID_MAX}}', account): return 65
    directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    @contextlib.contextmanager
    def opened(name, flags, parent=None):
        fd = os.open(name, flags, dir_fd=parent)
        try: yield fd
        finally: os.close(fd)
    def same(a, b): return a.st_dev == b.st_dev and a.st_ino == b.st_ino
    canonical = os.path.realpath(home)
    chain = []
    with contextlib.ExitStack() as stack:
        homefd = stack.enter_context(opened(canonical, directory))
        root = homefd
        parts = ['.nodeterm', 'claude-accounts', account, 'projects'] if account else ['.claude', 'projects']
        for part in parts:
            child = stack.enter_context(opened(part, directory, root))
            chain.append((root, part, child)); root = child
        def directories_current():
            if os.path.realpath(home) != canonical or not same(os.stat(canonical, follow_symlinks=False), os.fstat(homefd)): raise Unsafe()
            for parent, name, fd in chain:
                named = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISDIR(named.st_mode) or not same(named, os.fstat(fd)): raise Unsafe()
        directories_current()
        leaf = session + '.jsonl'
        matches = []
        names = []
        with os.scandir(root) as entries:
            for entry in entries:
                if len(names) >= ${DIRECTORY_LIMIT}: raise OSError()
                names.append(entry.name)
        for name in sorted(names):
            entry = os.stat(name, dir_fd=root, follow_symlinks=False)
            if stat.S_ISLNK(entry.st_mode): raise Unsafe()
            if not stat.S_ISDIR(entry.st_mode): continue
            with opened(name, directory, root) as project:
                try: item = os.stat(leaf, dir_fd=project, follow_symlinks=False)
                except FileNotFoundError: continue
                if not stat.S_ISREG(item.st_mode): raise Unsafe()
                matches.append(name)
        if not matches:
            directories_current()
            return 66
        if len(matches) != 1: raise Unsafe()
        project = stack.enter_context(opened(matches[0], directory, root))
        chain.append((root, matches[0], project))
        file = stack.enter_context(opened(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, project))
        initial = os.fstat(file)
        if not stat.S_ISREG(initial.st_mode): raise Unsafe()
        def current():
            directories_current()
            named = os.stat(leaf, dir_fd=project, follow_symlinks=False)
            if not stat.S_ISREG(named.st_mode) or not same(named, initial): raise Unsafe()
        current()
        size = initial.st_size
        end = size if before < 0 else min(size, before)
        start = max(0, end - limit)
        if start: start -= 1
        os.lseek(file, start, os.SEEK_SET)
        chunks = []; left = end - start
        while left:
            chunk = os.read(file, min(left, 65536))
            if not chunk: raise OSError()
            chunks.append(chunk); left -= len(chunk)
        current()
        print(json.dumps({'start': start, 'size': size, 'data': base64.b64encode(b''.join(chunks)).decode('ascii')}, separators=(',', ':')))
    return 0
try:
    sys.exit(main())
except Unsafe:
    sys.exit(67)
except OSError as error:
    sys.exit(67 if error.errno in (errno.ELOOP, errno.ENOTDIR) else 68)
except Exception:
    sys.exit(68)
`

export interface StrictTranscriptRead {
  home: string
  accountId?: string
  sessionId: string
  before: number | null
  maxBytes: number
}

export function strictTranscriptReadCommand(query: StrictTranscriptRead): string {
  if (!query.home.startsWith('/') || /[\0\r\n]/.test(query.home) || query.home.length > 4096 ||
    !SESSION_ID_RE.test(query.sessionId) || query.sessionId.length > 256 ||
    (query.accountId !== undefined && (!isSafeAccountId(query.accountId) || query.accountId.length > ACCOUNT_ID_MAX)) ||
    (query.before !== null && (!Number.isSafeInteger(query.before) || query.before < 0)) ||
    !Number.isSafeInteger(query.maxBytes) || query.maxBytes < 1 || query.maxBytes > CHAT_PAGE_MAX_BYTES)
    throw new Error('ssh-transcript-invalid-query')
  return ['python3', '-c', STRICT_TRANSCRIPT_PYTHON, query.home, query.accountId ?? '', query.sessionId,
    String(query.maxBytes), String(query.before ?? -1)].map(posixQuote).join(' ')
}

export interface StrictTranscriptPage { data: Buffer; start: number; size: number }
export function parseStrictTranscriptPage(stdout: string, query: Pick<StrictTranscriptRead, 'before' | 'maxBytes'>): StrictTranscriptPage {
  if (stdout.length > Math.ceil((query.maxBytes + 1) / 3) * 4 + 256) throw new Error('ssh-transcript-oversized-reply')
  const value: unknown = JSON.parse(stdout)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ssh-transcript-malformed-reply')
  const { start, size, data } = value as Record<string, unknown>
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || (size as number) < 0 || typeof data !== 'string')
    throw new Error('ssh-transcript-malformed-reply')
  const end = query.before === null ? size as number : Math.min(size as number, query.before)
  const base = Math.max(0, end - query.maxBytes); const expectedStart = base > 0 ? base - 1 : 0
  const decoded = Buffer.from(data, 'base64')
  if (start !== expectedStart || decoded.length !== end - expectedStart || decoded.toString('base64') !== data)
    throw new Error('ssh-transcript-malformed-range')
  return { data: decoded, start: start as number, size: size as number }
}
