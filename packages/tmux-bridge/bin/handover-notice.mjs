/** Build a successor link from resolved identifiers, never from a guessed URL. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const projectId = /^[A-Za-z0-9_-]{1,256}$/;
const threadId = /^cmsg_[A-Za-z0-9_-]{1,250}$/;

export function successorLink(target) {
  if (!target || typeof target !== 'object') throw new Error('invalid successor');
  if (target.kind === 'codex' && typeof target.id === 'string' && uuid.test(target.id)) return `codex://threads/${target.id}`;
  if (target.kind === 'cloud' && typeof target.sourceProject === 'string' && projectId.test(target.sourceProject) &&
      typeof target.targetProject === 'string' && projectId.test(target.targetProject) &&
      typeof target.thread === 'string' && threadId.test(target.thread)) {
    return target.sourceProject === target.targetProject ? `#${target.thread}` :
      `https://claude.ai/code/project/${target.targetProject}?thread=${target.thread}`;
  }
  throw new Error('invalid successor link identifiers');
}

export function formatFinalNotice({ target, label, prefix }) {
  if (typeof label !== 'string' || !label.trim() || label.length > 300 || /[\r\n\x00-\x1f\x7f]/.test(label) ||
      typeof prefix !== 'string' || !prefix.trim() || prefix.length > 500 || /[\r\n\x00-\x1f\x7f]/.test(prefix)) throw new Error('invalid notice text');
  const escaped = label.replace(/[\\\[\]]/g, '\\$&');
  return `${prefix} [${escaped}](${successorLink(target)})`;
}

/** Compare a trusted, complete transcript observation; this does not obtain one. */
export function matchesFinalNotice(observation, { session, message }) {
  if (!observation || observation.complete !== true || observation.session !== session ||
      typeof session !== 'string' || !session || typeof message !== 'string' || !message ||
      !Array.isArray(observation.messages) || !observation.messages.length) return false;
  const last = observation.messages.at(-1);
  return Boolean(last && last.role === 'assistant' && last.text === message);
}
