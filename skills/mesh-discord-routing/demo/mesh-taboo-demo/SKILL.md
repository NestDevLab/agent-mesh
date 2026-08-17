---
name: taboo-advanced
description: Play a lightweight Taboo Advanced guessing game over cc-mesh Discord routing. Use when agents are asked to test mesh routing, play Taboo Advanced, run a demo game between bots, or coordinate yes/no deduction rounds with a facilitator.
---

# Taboo Advanced

Use this skill to run a small Taboo Advanced game between agents over Discord mesh routing.

It is a routing demo first and a game second: keep turns short, route explicitly, and do not hand-write raw Discord mentions.

## Roles

- **Facilitator**: starts rounds, stores the secret target and banned words in session state, answers only yes/no, tracks guesses, and announces results.
- **Guessers**: ask yes/no questions until they have enough information, then make an explicit guess.
- **Observer**: may comment only when invited by the facilitator.

There is no clue-giver in Taboo Advanced. The facilitator must never give opening clues, hints, definitions, examples, analogies, or free-form explanations during an active round.

## Routing

When replying to a specific agent or group, use `mesh-discord-routing`.

Preferred:

```bash
mesh-hydrate --to facilitator --body "Ready for the next round."
mesh-hydrate --to agent-alpha --to agent-beta --body "Answer: yes."
```

Fallback:

```bash
node /path/to/mesh-discord-routing/scripts/mesh-hydrate.mjs --to facilitator --body "Ready."
```

Never hand-write Discord mentions. Keep `cc-mesh:` routing out of the body text unless the tool/script generated it.

When the Discord send tool supports native replies, send each Taboo answer as a
reply to the question/guess message being answered. Mentions route the bot;
native replies keep the human conversation readable.

Do not route active-round prompts or answers to every guesser at once. Pick one
active guesser, route the answer only to that guesser, then wait for the next
turn. Rotate guessers in the order stored in the state file unless the
facilitator explicitly chooses a different next player.

For multi-guesser rounds, create both:

- the Taboo state file under this skill's `state/` directory
- a mesh session state file with `mesh-session start`

The mesh session is the source of truth for the next recipient label. The Taboo
state remains the source of truth for game facts such as target, banned words,
questions, guesses, winner, and `turnsUsed`.

## Round Setup

The facilitator chooses:

- one or more guessers
- one target word
- 3 to 5 banned words
- optional turn limit, default 8 routed messages
- optional unlimited play: when the user asks for no round limit, set `turnLimit`
  to `null` and do not end the round because of `turnsUsed`

When there is more than one guesser, the round is sequential by default. Treat
`guessers` as a queue, invite only `activeGuesser`, and do not tag or invite the
next guesser until the current guesser has replied and the facilitator has ruled
the answer or guess. Do not pre-ping all players at round start unless the user
explicitly asks for simultaneous play.

Before announcing the round, the facilitator must create or update a session state file under this skill's `state/` directory.

Use a stable file name tied to the game session, for example:

```text
state/taboo-YYYYMMDDTHHMMSSZ-<channel-or-topic-id>.json
```

The state file must include at least:

```json
{
  "sessionId": "taboo-YYYYMMDDTHHMMSSZ-channel-id",
  "channelId": "channel-or-topic-id",
  "facilitator": "main",
  "guessers": ["agent-beta"],
  "activeGuesser": "agent-beta",
  "guesserQueue": ["agent-beta"],
  "target": "secret word",
  "bannedWords": ["first", "second", "third"],
  "turnLimit": 8,
  "turnsUsed": 0,
  "status": "active",
  "createdAt": "YYYY-MM-DDTHH:MM:SSZ"
}
```

For unlimited rounds, use `"turnLimit": null` in the state file and announce
`No turn limit.` instead of a numeric limit. Still increment `turnsUsed` for
auditability, but never end the round due to turn count when `turnLimit` is
`null`.

Read the state file before every clue, answer, ruling, or recap. Update `turnsUsed`, `status`, guesses, illegal clues, and winner as the round proceeds. This prevents the facilitator or clue-giver from forgetting the target and banned words during a long routed session.

The target and banned words stay only in the state file until the round ends. Do not reveal them in the public mesh channel during play.

## Answer Rules

The facilitator may answer only:

- `Answer: yes.`
- `Answer: no.`
- `Answer: not exactly.`
- `Answer: I cannot answer that as yes/no; please rephrase.`
- `Correct.`
- `Incorrect.`

During an active round, the facilitator must not use:

- the target word
- banned words
- obvious inflections or spelling variants of target/banned words
- direct translations if multilingual agents are involved
- initial letters, rhymes, or "sounds like" clues
- hints, definitions, examples, context, analogies, explanations, or unsolicited clues

## Guess Rules

The round starts with the guessers asking the first yes/no question. The facilitator must not give an opening clue.

Guessers should ask only yes/no questions until they have enough information. When ready, they may make one explicit guess with `Guess: ...`.

The facilitator answers briefly and routes back to the active guesser(s). The facilitator decides if a guess is correct or close enough.

## Facilitator Flow

1. Create the session state file with target, banned words, roles, and turn limit (`null` for unlimited play).
2. For multiple guessers, create mesh turn state:

   ```bash
   mesh-session start --session-id taboo-YYYYMMDDTHHMMSSZ-channel-id --channel-id channel-id --participants agent-alpha,agent-beta --policy round_robin --active agent-alpha --skill taboo-advanced
   ```

3. Announce the players, turn limit or `No turn limit`, and that guessers must start with yes/no questions.
4. Do not post target/banned words publicly.
5. If there is one guesser, invite that guesser to ask the first yes/no question.
   If there are multiple guessers, invite only `activeGuesser`.
6. Read and update the session state file on every turn.
7. Track questions, guesses, illegal answers, correct guesses, and exhausted turns.
8. For sequential multi-guesser rounds:
   - answer or rule only the current `activeGuesser`
   - if the guess is correct, set `status: "complete"` and end the round
   - if the guess is incorrect, or the current guesser passes/exhausts their turn,
     advance with `mesh-session next --state ... --from <current>` and invite
     only the returned `to` recipient
   - if `turnLimit` is `null`, skip all turn-limit exhaustion checks
   - if a non-active guesser replies early, either ignore it or route a compact
     wait notice; do not count it as a turn unless the facilitator explicitly
     changes `activeGuesser`
9. End with a short recap: target, winner, illegal answers if any, state file path, mesh state path, and whether routing worked.

## Output Style

Keep game messages compact. Prefer:

```text
Taboo Advanced: Agent Beta guesses. Limit: 6 turns. Start with one yes/no question; guess only when you have enough clues.
```

```text
Question: Is it usually found indoors?
```

```text
Answer: yes.
```

For a complete sample round, read `references/sample-round.md`.
