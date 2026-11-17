// Public mechanism files must not embed private deployment policy or identifiers.
const privatePatterns = [/\/(?:home|Users)\/[A-Za-z0-9_.-]+(?:\/|\b)/i];

export function isPlexusMechanismFile(relativePath) {
  return /^(?:docs\/design\/plexus[-.]|packages\/tmux-bridge\/README\.md$|(?:packages\/tmux-bridge\/(?:bin|examples|test)|skills\/agent-tmux\/bin)\/(?:plexus[-.]|channel-|claude-(?:delivery|native)-|cloud-(?:account|native)-|codex-(?:compaction|wake|mcp|role|native)-|isolated-|namespace-|trigger-|native-|module-batches|mesh-(?:graph|channel)|agent-waker|role-(?:launch|mcp)-|session-(?:sleep|handover)|(?:sleep|handover|restart)-))/.test(relativePath);
}

export function containsPrivatePlexusPolicy(text, markers = []) {
  if (!Array.isArray(markers) || markers.some((marker) => typeof marker !== 'string' || !marker.trim())) throw new Error('invalid private markers');
  const normalized = text.toLowerCase();
  return privatePatterns.some((pattern) => pattern.test(text)) || markers.some((marker) => normalized.includes(marker.toLowerCase()));
}

// Python writes interpreter-specific binary caches while the test suite runs.
// Keep scanning any source files placed in such directories.
export function isGeneratedPythonBytecode(relativePath, trackedFiles) {
  return trackedFiles instanceof Set && !trackedFiles.has(relativePath) && /(?:^|\/)__pycache__\/[^/]+\.cpython-\d+(?:\.opt-\d+)?\.pyc$/.test(relativePath);
}
