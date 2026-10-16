// Tracks server → client requests (approvals, elicitations, user-input) for the
// lifetime of one bridge process.
//
// Why: the bridge fans a request out to every connected browser client. Without
// bookkeeping, a second client (or the same client twice, or a late answer after
// the server already resolved the request) would be forwarded into a request id
// the server no longer knows about — at best an error, at worst a decision
// applied to the wrong pending request.
//
// The protocol gives us the two signals needed to keep this honest:
//   serverRequest/resolved { threadId, requestId }   -> the server is done with it
//   turn/completed         { threadId, turn }        -> nothing of that turn can
//                                                       still be pending
//
// Pure on purpose (no timers, no I/O, injected clock) so the behaviour is
// unit-testable; wiring lives in server.ts.
export function createRequestRegistry({ ttlMs = 15 * 60 * 1000 } = {}) {
  const pending = new Map();

  // `Number(null)` is 0 and `Number.isSafeInteger(0)` is true, so a naive
  // conversion lets null/""/false through as "id 0". Only accept a real number
  // (or a numeric string, since ids also arrive as JSON strings in places).
  const toRequestId = (value) => {
    if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
  };

  const sweep = (now) => {
    for (const [id, entry] of pending) {
      if (now - entry.createdAt > ttlMs) pending.delete(id);
    }
  };

  return {
    get size() {
      return pending.size;
    },

    /** Remember an outgoing server request. Returns the stored entry, or null. */
    register(request, now = Date.now()) {
      sweep(now);
      const id = toRequestId(request?.id);
      if (id === null) return null;
      const params = request?.params ?? {};
      const entry = {
        requestId: id,
        method: request?.method ?? null,
        threadId: params.threadId ?? null,
        turnId: params.turnId ?? null,
        itemId: params.itemId ?? null,
        // Multiple callbacks can share one item (zsh-exec-bridge subcommands,
        // stdin approvals); approvalId is what tells them apart.
        approvalId: params.approvalId ?? null,
        kind: params.kind ?? null,
        // Keep the original request so a freshly loaded page can restore the
        // card. Without this, reloading while a request is pending loses the
        // only way to answer it and the turn waits forever.
        request: request ?? null,
        createdAt: now,
      };
      pending.set(id, entry);
      return entry;
    },

    /**
     * Take ownership of a request so it can be answered exactly once.
     * Returns { ok: true, entry } or { ok: false, reason }.
     */
    claim(requestId, now = Date.now()) {
      sweep(now);
      const id = toRequestId(requestId);
      if (id === null) return { ok: false, reason: "invalid-request-id" };
      const entry = pending.get(id);
      if (!entry) return { ok: false, reason: "already-resolved-or-unknown" };
      pending.delete(id);
      return { ok: true, entry };
    },

    /** The server resolved it (someone answered, or it was cancelled). */
    resolve(requestId, now = Date.now()) {
      sweep(now);
      const id = toRequestId(requestId);
      return id === null ? false : pending.delete(id);
    },

    /** Drop everything belonging to a finished turn. */
    clearTurn(threadId, turnId, now = Date.now()) {
      sweep(now);
      let removed = 0;
      for (const [id, entry] of pending) {
        const sameTurn = turnId != null && entry.turnId === turnId;
        const sameThreadWithoutTurn = turnId == null && threadId != null && entry.threadId === threadId;
        if (sameTurn || sameThreadWithoutTurn) {
          pending.delete(id);
          removed += 1;
        }
      }
      return removed;
    },

    list() {
      return [...pending.values()];
    },
  };
}
