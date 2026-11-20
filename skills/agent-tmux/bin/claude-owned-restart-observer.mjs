/** Private stdin adapter; caller is responsible for process and checkpoint trust. */
import { observeClaudeRestartFrame } from './claude-restart-observation.mjs';

let raw = '';
try {
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('request too large');
  }
  const input = JSON.parse(raw);
  const proof = await observeClaudeRestartFrame(input);
  process.stdout.write(JSON.stringify(proof));
} catch {
  process.stderr.write('restart observation failed\n');
  process.exitCode = 1;
}
