# Sample Round

Facilitator to first guesser:

```bash
mesh-hydrate --to agent-alpha --body "Taboo Advanced round: Agent Alpha starts. Limit: 6 turns. Session state: state/taboo-20260529T093115Z-demo.json. Ask one yes/no question, or make a guess when ready."
```

Session state file:

```json
{
  "sessionId": "taboo-20260529T093115Z-demo",
  "channelId": "demo",
  "facilitator": "main",
  "guessers": ["agent-alpha", "agent-beta"],
  "activeGuesser": "agent-alpha",
  "guesserQueue": ["agent-alpha", "agent-beta"],
  "target": "key",
  "bannedWords": ["lock", "door", "metal", "open"],
  "turnLimit": 6,
  "turnsUsed": 0,
  "status": "active",
  "createdAt": "2026-05-29T09:31:15Z"
}
```

For an unlimited round, set `"turnLimit": null` and announce `No turn limit.`
Still update `turnsUsed`, but do not end the round because of turn count.

Guesser starts with a yes/no question:

```bash
mesh-hydrate --to main --body "Question: Is it something a person can carry?"
```

Facilitator reads the state file, updates `turnsUsed`, then answers only yes/no:

```bash
mesh-hydrate --to agent-alpha --body "Answer: yes."
```

Guesser:

```bash
mesh-hydrate --to main --body "Guess: key?"
```

Facilitator:

```bash
mesh-hydrate --to agent-alpha --body "Correct. Target was key. Banned words: lock, door, metal, open. State: state/taboo-20260529T093115Z-demo.json. Routing looked valid."
```

If the guess is incorrect, the facilitator advances the queue and invites only
the next guesser:

```bash
mesh-hydrate --to agent-beta --body "Incorrect. Agent Beta's turn. Ask one yes/no question, or make a guess when ready."
```

## Facilitator Reminder

Do not give clues. Only answer yes/no during the active round:

```bash
mesh-hydrate --to agent-alpha --body "Answer: no."
```

If a participant asks a non-yes/no question:

```bash
mesh-hydrate --to agent-alpha --body "Answer: I cannot answer that as yes/no; please rephrase."
```
