const { spawn, execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const maxResultBytes = 12 * 1024 * 1024;
const maxStderr = 128 * 1024;
const maxTime = 45000;
const maxSnapshotBytes = 50 * 1024 * 1024;
const maxSnapshotEntries = 10000;
let running = 0;

async function snapshot(root, signal, copyTo) {
  const hashes = new Map();
  const pending = [''];
  let entries = 0;
  let size = 0;
  while (pending.length) {
    const directory = pending.pop();
    const files = await fs.opendir(path.join(root, directory));
    if (copyTo && directory) {
      const target = path.join(copyTo, directory);
      await fs.mkdir(target);
      await fs.chmod(target, 0o755);
    }
    for await (const entry of files) {
      signal?.throwIfAborted();
      if (++entries > maxSnapshotEntries) throw new Error('The analyzer snapshot exceeds the entry limit.');
      // The analyzer sees only the captured tree, with no Git metadata, old SCIP artifacts, or symlinks.
      if (entry.name.toLowerCase() === '.git' || /\.scip$/i.test(entry.name)) continue;
      const relative = directory ? directory + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { pending.push(relative); continue; }
      if (!entry.isFile()) continue;
      const file = await fs.open(path.join(root, relative), 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || size + stat.size > maxSnapshotBytes) {
          throw new Error('The analyzer snapshot exceeds the source byte limit.');
        }
        const bytes = Buffer.alloc(stat.size);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== stat.size || (await file.stat()).size !== stat.size) {
          throw new Error('The source snapshot changed during analysis.');
        }
        size += bytes.length;
        hashes.set(relative, createHash('sha256').update(bytes).digest('hex'));
        if (copyTo) {
          const target = path.join(copyTo, relative);
          await fs.writeFile(target, bytes, { flag: 'wx' });
          await fs.chmod(target, 0o644);
        }
      } finally {
        await file.close();
      }
    }
  }
  return hashes;
}

/** Images are provisioned by the operator. They write one JSON result to stdout. */
function nativeProvider(outputDir) {
  let attempts = 0;
  return async (root, language, signal) => {
    signal?.throwIfAborted();
    const key = 'COCKPIT_ANALYZER_IMAGE';
    const image = process.env[key];
    if (!image) return;
    if (!/^(sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64})$/.test(image)) {
      throw new Error(key + ' must identify a preinstalled image by its SHA-256 digest or image ID.');
    }
    if (++attempts > 4 || running >= 2) throw new Error('The isolated analysis capacity was reached.');
    const suffix = randomUUID();
    const name = 'cockpit-native-' + suffix;
    if (!path.isAbsolute(root) || !path.isAbsolute(outputDir) || /[,"\r\n]/.test(outputDir)) {
      throw new Error('The workspace path is incompatible with the isolated analyzer mount.');
    }

    running++;
    let captured;
    try {
      captured = await fs.mkdtemp(path.join(outputDir, 'snapshot-'));
      await fs.chmod(captured, 0o755);
      const sourceHashes = await snapshot(root, signal, captured);
      signal?.throwIfAborted();
      const mount = 'type=bind,src=' + captured + ',dst=/workspace,readonly';
      const output = await new Promise((resolve, reject) => {
        const child = spawn('docker', [
          'run', '--rm', '--pull=never', '--name', name,
          '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
          '--log-driver=none',
          '--memory=1g', '--memory-swap=1g', '--pids-limit=128', '--cpus=2',
          '--user=65532:65532', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
          '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--mount', mount,
          '--workdir', '/workspace', image, language, '/workspace'
        ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let size = 0;
        let stderr = 0;
        let failure;
        let remove;
        let closed = false;
        function stop(error) {
          if (failure || closed) return;
          failure = error;
          remove = new Promise(done => {
            execFile('docker', ['rm', '-f', name], { timeout: 6000, windowsHide: true }, () => {
              child.kill();
              done();
            });
          });
        }
        const abort = () => stop(signal.reason ?? new Error('Indexing was canceled.'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const timer = setTimeout(() => stop(new Error('The isolated analyzer timed out.')), maxTime);
        child.stdout.on('data', chunk => {
          size += chunk.length;
          if (size > maxResultBytes) stop(new Error('The isolated analyzer exceeded the JSON output limit.'));
          else if (!failure) chunks.push(chunk);
        });
        child.stderr.on('data', chunk => {
          stderr += chunk.length;
          if (stderr > maxStderr) stop(new Error('The isolated analyzer exceeded the diagnostic output limit.'));
        });
        child.on('error', error => {
          failure ??= new Error(error.code === 'ENOENT'
            ? 'The Docker executable is unavailable.' : 'The isolated analyzer could not be launched.');
        });
        child.on('close', async code => {
          closed = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          await remove;
          if (failure) reject(failure);
          else if (code !== 0) reject(new Error(code === 125
            ? 'Docker could not start the configured local analyzer image.' : 'The isolated analyzer exited unsuccessfully.'));
          else if (!size) reject(new Error('The isolated analyzer returned an empty JSON result.'));
          else resolve(Buffer.concat(chunks, size));
        });
      });
      signal?.throwIfAborted();
      const current = await snapshot(root, signal);
      if (current.size !== sourceHashes.size || [...sourceHashes].some(([name, hash]) => current.get(name) !== hash)) {
        throw new Error('The source snapshot changed during analysis.');
      }
      return { bytes: output, sourceHashes };
    } finally {
      running--;
      if (captured) await fs.rm(captured, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  };
}

module.exports = { nativeProvider };

