# Decision requests

`bin/agent-decision.py` carries one choice from a session to its owner through a
Director session, and the answer back. Reminders and follow-up stay with the
Director. The work item stays the record of what was decided; the state here only
tracks delivery.

```sh
agent-decision.py --config host.json send --request request.json --from codex:<uuid>
agent-decision.py --config host.json answer <id> --option <option id> --by <owner> --card <message id>
```

## Request

```json
{
  "id": "WORK-1",
  "question": "Ship the new flow today?",
  "where": "https://example.test/thread/1",
  "waitingSince": "2026-03-27T12:00:00Z",
  "project": "Example",
  "options": [
    {"id": "ship", "label": "Ship", "consequence": "Live today", "recommended": true, "reason": "Tests pass"},
    {"id": "later", "label": "Wait", "consequence": "Ships next week"}
  ]
}
```

A request has one or two real options and exactly one recommendation with its
reason. The card always appends two exits, `discuss` and `other`, so it never
exceeds four options. `other` is the only option that takes `--text`.

## Host configuration

| Field | Meaning |
| --- | --- |
| `target` | Director ref, used when `--to` is absent |
| `labels` | Card wording: `recommended`, `discuss`, `other`, `discussConsequence`, `otherConsequence`, `fallback` |
| `messagePrefix` | Text placed before every delivered message |
| `stateRoot` | Default `$XDG_STATE_HOME/agent-mesh/decisions` |
| `managedInboxRoot` | Claude managed inbox root |

Refs are `claude:<uuid>`, `codex:<uuid>` or `cloud:<session id>`.

## Delivery

The request is saved before delivery. Exit 75 means it wasn't accepted, and
rerunning the same command retries with the same delivery key. Exit 2 means the
input was refused: a malformed request, different content under an existing id,
an unknown option, or a second answer that disagrees with the first.

Claude targets need a live managed inbox. A cloud send counts only when the
transport prints its acceptance line. A timeout can hide an accepted send, so a
retry may repeat a message and Directors dedupe on the decision id.

An answer is a message from another session. It says which question it covers,
and it doesn't get past a permission prompt or a guard in the receiving session.
