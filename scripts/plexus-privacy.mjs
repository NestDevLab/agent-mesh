// Public mechanism files must not embed private deployment policy or identifiers.
const privatePatterns = [
  new RegExp('gale' + 'haut', 'i'),
  new RegExp('management:' + 'MGT-[0-9]+', 'i'),
  new RegExp('/home/' + 'administrator(?:/|\\b)', 'i'),
];

export function isPlexusMechanismFile(relativePath) {
  return /^(?:docs\/design\/plexus[-.]|packages\/tmux-bridge\/README\.md$|(?:packages\/tmux-bridge\/(?:bin|examples|test)|skills\/agent-tmux\/bin)\/(?:plexus[-.]|channel-|module-batches|mesh-(?:graph|channel)|agent-waker|session-(?:sleep|handover)|(?:sleep|handover)-))/.test(relativePath);
}

export function containsPrivatePlexusPolicy(text) {
  return privatePatterns.some((pattern) => pattern.test(text));
}
