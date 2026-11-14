const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const imageVariables = {
  python: 'COCKPIT_SCIP_PYTHON_IMAGE',
  go: 'COCKPIT_SCIP_GO_IMAGE',
  java: 'COCKPIT_SCIP_JAVA_IMAGE',
  c: 'COCKPIT_SCIP_CLANG_IMAGE',
  cpp: 'COCKPIT_SCIP_CLANG_IMAGE'
};
const maxIndexBytes = 12 * 1024 * 1024;
const maxStderr = 128 * 1024;
const maxTime = 45000;
let running = 0;

/** Images are provisioned by the operator. They write one SCIP index to stdout. */
function indexProvider(outputDir) {
  let attempts = 0;
  return async (project, signal) => {
    signal?.throwIfAborted();
    const key = imageVariables[project.language];
    const image = process.env[key];
    if (!image) return;
    if (!/^(sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64})$/.test(image)) {
      throw new Error(key + ' must identify a preinstalled image by its SHA-256 digest or image ID.');
    }
    if (++attempts > 4 || running >= 2) throw new Error('The isolated indexing capacity was reached.');
    const suffix = randomUUID();
    const name = 'cockpit-scip-' + suffix;
    const mount = 'type=bind,src=' + project.root + ',dst=/workspace,readonly';
    if (!path.isAbsolute(project.root) || /[,"\r\n]/.test(project.root)) {
      throw new Error('The workspace path is incompatible with the isolated indexer mount.');
    }

    running++;
    try {
      const output = await new Promise((resolve, reject) => {
        const child = spawn('docker', [
          'run', '--rm', '--pull=never', '--name', name,
          '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
          '--log-driver=none',
          '--memory=1g', '--memory-swap=1g', '--pids-limit=128', '--cpus=2',
          '--user=65532:65532', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
          '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--mount', mount,
          '--workdir', '/workspace', image, project.language
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
        const timer = setTimeout(() => stop(new Error('The isolated indexer timed out.')), maxTime);
        child.stdout.on('data', chunk => {
          size += chunk.length;
          if (size > maxIndexBytes) stop(new Error('The isolated indexer exceeded the SCIP output limit.'));
          else if (!failure) chunks.push(chunk);
        });
        child.stderr.on('data', chunk => {
          stderr += chunk.length;
          if (stderr > maxStderr) stop(new Error('The isolated indexer exceeded the diagnostic output limit.'));
        });
        child.on('error', error => {
          failure ??= new Error(error.code === 'ENOENT'
            ? 'The Docker executable is unavailable.' : 'The isolated indexer could not be launched.');
        });
        child.on('close', async code => {
          closed = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          await remove;
          if (failure) reject(failure);
          else if (code !== 0) reject(new Error(code === 125
            ? 'Docker could not start the configured local indexer image.' : 'The isolated indexer exited unsuccessfully.'));
          else if (!size) reject(new Error('The isolated indexer returned an empty SCIP index.'));
          else resolve(Buffer.concat(chunks, size));
        });
      });
      signal?.throwIfAborted();
      const target = path.join(outputDir, suffix + '.scip');
      await fs.writeFile(target, output, { flag: 'wx' });
      return target;
    } finally {
      running--;
    }
  };
}

module.exports = { indexProvider };

