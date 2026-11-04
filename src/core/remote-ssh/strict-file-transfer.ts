import { posixQuote } from '../../shared/ssh'

export const REMOTE_TRANSFER_MAX_BYTES = 128 * 1024 * 1024
export interface TransferFileIdentity { parents: string[][]; file: string[] | null }
export interface TransferFileStat { size: number; identity: TransferFileIdentity }
export type TransferFileQuery = {
  root: string; relativePath: string; operation: 'stat' | 'read' | 'create' | 'receipt'
  identity?: TransferFileIdentity; offset?: number; length?: number; bytes?: number; nonce?: string
}

// All filesystem authority is descriptor-relative. No shell expansion, symlink traversal,
// overwrite or caller-selected receipt path. The bounded receipt lives on the published inode.
export const STRICT_FILE_TRANSFER_PYTHON = String.raw`
import os, sys, stat, json, hashlib, errno, re, signal
CAP = 134217728
ATTR = 'user.nodeterm.transfer'
class Unsafe(Exception): pass
class Unsupported(Exception): pass
def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n'); sys.stdout.flush()
def ident(s): return [str(s.st_dev), str(s.st_ino)]
def fingerprint(s): return ident(s) + [str(s.st_size), str(s.st_mtime_ns), str(s.st_ctime_ns)]
def regular(fd):
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_size > CAP: raise Unsafe()
    return s
def main():
    q = json.loads(sys.argv[1]); root = q['root']; rel = q['relativePath']; op = q['operation']
    if not isinstance(root, str) or not root.startswith('/') or len(root) > 4096 or '\0' in root: raise Unsafe()
    if not isinstance(rel, str) or len(rel) > 4096 or '\0' in rel or rel.startswith('/'): raise Unsafe()
    roots = [v for v in root.split('/') if v]
    parts = rel.split('/')
    if not parts or any(v in ('', '.', '..') for v in parts) or any(v in ('.', '..') for v in roots) or len(roots) + len(parts) > 128: raise Unsafe()
    fds = []; chain = []; parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); fds.append(parent)
    content = None; published = False; attempted = False
    try:
        for name in roots + parts[:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            fds.append(child); chain.append((parent, name, child)); parent = child
        leaf = parts[-1]
        directory_fds = list(fds)
        parents = [ident(os.fstat(fd)) for fd in directory_fds]
        def directories_current():
            if [ident(os.fstat(fd)) for fd in directory_fds] != parents: raise Unsafe()
            for p, name, fd in chain:
                s = os.stat(name, dir_fd=p, follow_symlinks=False)
                if not stat.S_ISDIR(s.st_mode) or ident(s) != ident(os.fstat(fd)): raise Unsafe()
        directories_current()
        try:
            content = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            fds.append(content); initial = regular(content)
            identity = {'parents': parents, 'file': fingerprint(initial)}
        except FileNotFoundError:
            content = None; initial = None; identity = {'parents': parents, 'file': None}
        def file_current():
            directories_current()
            if content is None: return
            named = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(named.st_mode) or fingerprint(named) != identity['file'] or fingerprint(regular(content)) != identity['file']: raise Unsafe()
        file_current()
        if op == 'stat':
            emit({'ok': True, 'size': initial.st_size if initial else 0, 'identity': identity}); return 0
        if q.get('identity', {}).get('parents') != parents: raise Unsafe()
        if op == 'read':
            if content is None or q['identity'] != identity: raise Unsafe()
            offset = q.get('offset'); length = q.get('length')
            if type(offset) != int or type(length) != int or offset < 0 or length < 0 or length > CAP or offset + length > initial.st_size: raise Unsafe()
            emit({'ok': True, 'bytes': length, 'identity': identity})
            os.lseek(content, offset, os.SEEK_SET); left = length
            while left:
                file_current(); chunk = os.read(content, min(left, 65536))
                if not chunk: raise Unsafe()
                file_current()
                sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush(); left -= len(chunk)
            file_current(); return 0
        nonce = q.get('nonce', '')
        if not isinstance(nonce, str) or not re.fullmatch('[a-f0-9]{32}', nonce): raise Unsafe()
        if op == 'receipt':
            if content is None: emit({'outcome': 'unknown'}); return 0
            try: receipt = json.loads(os.getxattr(content, ATTR))
            except (OSError, ValueError, AttributeError): emit({'outcome': 'unknown'}); return 0
            if receipt.get('nonce') != nonce or receipt.get('bytes') != initial.st_size: emit({'outcome': 'unknown'}); return 0
            digest = hashlib.sha256()
            while True:
                file_current(); chunk = os.read(content, 65536)
                if not chunk: break
                digest.update(chunk)
            file_current()
            if digest.hexdigest() != receipt.get('sha256'): emit({'outcome': 'unknown'}); return 0
            os.fsync(content); os.fsync(parent)
            emit({'outcome': 'committed', 'bytes': initial.st_size, 'sha256': digest.hexdigest()}); return 0
        if op != 'create': raise Unsafe()
        size = q.get('bytes')
        if type(size) != int or size < 0 or size > CAP: raise Unsafe()
        if content is not None or q['identity'].get('file') is not None:
            emit({'outcome': 'conflict'}); return 0
        # Anonymous inode: disconnect/process death cannot leave a named partial file.
        try: content = os.open('.', os.O_RDWR | os.O_TMPFILE, 0o600, dir_fd=parent)
        except (OSError, AttributeError): raise Unsupported()
        fds.append(content); temp_identity = ident(os.fstat(content))
        digest = hashlib.sha256(); left = size
        while left:
            chunk = sys.stdin.buffer.read(min(left, 65536))
            if not chunk: emit({'outcome': 'not-written'}); return 0
            digest.update(chunk); view = memoryview(chunk)
            while view:
                count = os.write(content, view)
                if count <= 0: raise OSError()
                view = view[count:]
            left -= len(chunk)
        marker = ('\nNT_COMMIT_' + nonce + '\n').encode('ascii')
        if sys.stdin.buffer.read(len(marker)) != marker or sys.stdin.buffer.read(1): emit({'outcome': 'not-written'}); return 0
        receipt = {'nonce': nonce, 'bytes': size, 'sha256': digest.hexdigest()}
        try: os.setxattr(content, ATTR, json.dumps(receipt, separators=(',', ':')).encode('ascii'))
        except (OSError, AttributeError): raise Unsupported()
        os.fsync(content); os.fsync(parent); directories_current()
        attempted = True
        # Publish the opened inode, never a replaceable temporary pathname. Linux procfs
        # follows this process-owned descriptor; unsupported hosts fail without publication.
        try: os.link('/proc/self/fd/' + str(content), leaf, dst_dir_fd=parent, follow_symlinks=True)
        except FileExistsError:
            attempted = False; emit({'outcome': 'conflict'}); return 0
        published = True
        os.fsync(parent); directories_current()
        named = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        if ident(named) != temp_identity or named.st_size != size: raise Unsafe()
        emit({'outcome': 'committed', 'bytes': size, 'sha256': digest.hexdigest()}); return 0
    except Unsupported:
        emit({'outcome': 'unavailable'}); return 0
    except Exception:
        if op == 'create': emit({'outcome': 'unknown' if attempted or published else 'not-written'}); return 0
        raise
    finally:
        for fd in reversed(fds):
            try: os.close(fd)
            except Exception: pass
def expired(_sig, _frame): raise Unsafe()
signal.signal(signal.SIGALRM, expired)
signal.alarm(120)
try: sys.exit(main())
except Exception: sys.exit(68)
`

export function transferFileCommand(query: TransferFileQuery): string {
  if (!query.root.startsWith('/') || query.root.length > 4096 || query.root.includes('\0') ||
    !query.relativePath || query.relativePath.length > 4096 || query.relativePath.includes('\0') || query.relativePath.startsWith('/') ||
    query.relativePath.split('/').some(part => !part || part === '.' || part === '..') ||
    query.root.split('/').some(part => part === '.' || part === '..')) throw new Error('remote-transfer-invalid-path')
  return 'exec ' + ['python3', '-c', STRICT_FILE_TRANSFER_PYTHON, JSON.stringify(query)].map(posixQuote).join(' ')
}

export function parseTransferStat(line: string): TransferFileStat {
  if (line.length > 32768) throw new Error('remote-transfer-invalid-stat')
  const value = JSON.parse(line)
  const component = (part: unknown) => typeof part === 'string' && /^\d{1,32}$/.test(part)
  const identity = value?.identity
  if (value?.ok !== true || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > REMOTE_TRANSFER_MAX_BYTES ||
    !identity || !Array.isArray(identity.parents) || identity.parents.length < 1 || identity.parents.length > 129 ||
    !identity.parents.every((part: unknown) => Array.isArray(part) && part.length === 2 && part.every(component)) ||
    !(identity.file === null || Array.isArray(identity.file) && identity.file.length === 5 && identity.file.every(component)) ||
    (identity.file === null ? value.size !== 0 : Number(identity.file[2]) !== value.size)) throw new Error('remote-transfer-invalid-stat')
  return { size: value.size, identity }
}

export function transferCommitMarker(nonce: string): Buffer {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('remote-transfer-invalid-reference')
  return Buffer.from('\nNT_COMMIT_' + nonce + '\n', 'ascii')
}
