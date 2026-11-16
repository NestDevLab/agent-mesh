// Public mechanism files must not embed private deployment policy or identifiers.
const privatePatterns = [
  new RegExp('gale' + 'haut', 'i'),
  new RegExp('management:' + 'MGT-[0-9]+', 'i'),
  new RegExp('/home/' + 'administrator(?:/|\\b)', 'i'),
];

export function isPlexusMechanismFile(relativePath) {
  return /^(?:docs\/design\/plexus[-.]|packages\/tmux-bridge\/README\.md$|(?:packages\/tmux-bridge\/(?:bin|examples|test)|skills\/agent-tmux\/bin)\/(?:plexus[-.]|channel-|claude-delivery-|cloud-(?:account|native)-|codex-(?:compaction|wake)-|module-batches|mesh-(?:graph|channel)|agent-waker|role-(?:launch|mcp)-|session-(?:sleep|handover)|(?:sleep|handover|restart)-))/.test(relativePath);
}

export function containsPrivatePlexusPolicy(text) {
  return privatePatterns.some((pattern) => pattern.test(text));
}

// Python writes interpreter-specific binary caches while the test suite runs.
// Keep scanning any source files placed in such directories.
export function isGeneratedPythonBytecode(relativePath, trackedFiles) {
  return trackedFiles instanceof Set && !trackedFiles.has(relativePath) && /(?:^|\/)__pycache__\/[^/]+\.cpython-\d+(?:\.opt-\d+)?\.pyc$/.test(relativePath);
}
