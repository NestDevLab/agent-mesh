# Channel transition prototype

`channel-state.mjs` defines pure JSON transitions for a stable channel, its
current session and a queue. An in-flight message is bound to a session and
generation. A handover stops new dispatch and cannot finish while a delivery is
unresolved. Only a matching acceptance receipt resolves an in-flight message.

This is not yet a channel service: it has no durable transactional store,
concurrent-writer arbitration, transport, authorization, waker integration,
recovery procedure or session verification. The caller must not treat the
`verified` argument as evidence by itself. It must establish all of these
properties before connecting the transitions to live sessions.
