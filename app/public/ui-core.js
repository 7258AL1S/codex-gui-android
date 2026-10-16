export const DEFAULT_TURN_PAGE_SIZE = 20;

export function createLatestRequestGate() {
  let generation = 0;
  return {
    next() { generation += 1; return generation; },
    isCurrent(value) { return value === generation; },
  };
}

export function createTurnWindow(turns, pageSize = DEFAULT_TURN_PAGE_SIZE, currentStart, loadMore = 0) {
  const total = Array.isArray(turns) ? turns.length : 0;
  const safePage = Math.max(1, pageSize);
  const baseStart = currentStart == null ? Math.max(0, total - safePage) : Math.max(0, Math.min(currentStart, total));
  const start = Math.max(0, baseStart - Math.max(0, loadMore));
  return { visible: turns.slice(start), hiddenCount: start, start, total };
}

export function selectModelState(models, requestedModel) {
  const catalog = Array.isArray(models) ? models : [];
  const selected = catalog.find((item) => item.model === requestedModel)
    || catalog.find((item) => item.isDefault)
    || catalog[0]
    || { model: "", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] };
  const efforts = (selected.supportedReasoningEfforts || []).map((item) => item.reasoningEffort).filter(Boolean);
  const effort = efforts.includes(selected.defaultReasoningEffort)
    ? selected.defaultReasoningEffort
    : (efforts[0] || selected.defaultReasoningEffort || "medium");
  return { model: selected.model, effort, efforts: efforts.length ? efforts : [effort] };
}

export function filterAppModels(models) {
  // Upstream kept only models whose id/display name starts with `gpt`, which
  // empties the catalog on any non-OpenAI provider: this machine runs a DeepSeek
  // provider whose catalog is ["deepseek-flash", "deepseek-v4-pro"], so the list
  // came back empty, the UI fell back to `model: ""`, and the server answered
  // "No models are available. Set `model` explicitly or check your model catalog
  // configuration." — nothing could be sent from the browser.
  //
  // Models are now taken from real capability discovery (VERIFICATION.md E3/E37):
  // keep everything the server marks as selectable, whatever the provider.
  return (Array.isArray(models) ? models : []).filter((model) => {
    if (!model || typeof model !== "object") return false;
    if (model.hidden === true) return false;
    return String(model.model || model.id || "").trim() !== "";
  });
}

export function resolveComposerPlaceholder({
  followUpType,
  composerMode = "local",
  cloudStartingState,
  isBackgroundSubagentsPanelVisible = false,
  isGoalModeActive = false,
  isPlanModeActive = false,
  placeholderText,
  isHome = false,
} = {}) {
  if (isGoalModeActive) return "Describe your goal, define measurable outcomes for best results";
  if (isPlanModeActive) return "Describe your task to generate a plan...";
  if (placeholderText != null) return placeholderText;
  if (followUpType === "cloud") {
    if (composerMode === "local") return "Create a new local task that references this cloud task";
    if (cloudStartingState === "working-tree") return "Create a new cloud task that includes your current code and will reference this task";
    return "Follow-up to this cloud task";
  }
  if (followUpType === "local") {
    if (composerMode === "cloud") return "Follow-up in a new cloud task";
    return isBackgroundSubagentsPanelVisible
      ? "Ask for follow up changes or @ to tag an agent"
      : "Ask for follow-up changes";
  }
  if (isHome && composerMode === "local") return "Do anything";
  return composerMode === "cloud"
    ? "Ask Codex to do anything in the cloud"
    : "Ask ChatGPT anything. @ to use plugins or mention files";
}

export function getComposerAutocomplete(text, cursor = text.length) {
  const value = String(text || "");
  const end = Math.max(0, Math.min(Number.isFinite(cursor) ? cursor : value.length, value.length));
  const before = value.slice(0, end);
  const slash = before.match(/^\s*\/([^\s/]*)$/);
  if (slash) {
    const start = before.indexOf("/");
    return { type: "slash", query: slash[1], start, end };
  }
  const mention = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!mention) return null;
  const start = before.lastIndexOf("@");
  return { type: "mention", query: mention[1], start, end };
}

export function applyComposerSuggestion(text, match, replacement) {
  const value = String(text || "");
  if (!match || match.start < 0 || match.end < match.start) return { text: value, cursor: value.length };
  const before = value.slice(0, match.start);
  const after = value.slice(match.end);
  const needsSpace = after.length === 0 || !/^\s/.test(after);
  const inserted = String(replacement || "") + (needsSpace ? " " : "");
  return { text: before + inserted + after, cursor: before.length + inserted.length };
}

/**
 * Keeps the Android back gesture from leaving the app while a drawer, panel or
 * dialog is open.
 *
 * Opening an overlay pushes one history entry; a back press pops it and closes
 * the overlay instead of navigating away. Closing the overlay from the UI pops
 * the entry again so the history stays balanced.
 *
 * Pure on purpose (history is injected) so the behaviour is unit-testable —
 * getting this wrong can trap the user, and there is no browser here to click
 * through it.
 */
export function createOverlayBackGuard({ history, onClose, stateKey = "codexOverlayBack" } = {}) {
  let depth = 0;
  const hasHistory = history && typeof history.pushState === "function" && typeof history.back === "function";
  return {
    get depth() {
      return depth;
    },
    /** Call right after an overlay becomes visible. */
    opened() {
      if (!hasHistory) return false;
      depth += 1;
      try {
        history.pushState({ [stateKey]: depth }, "");
      } catch {
        depth -= 1;
        return false;
      }
      return true;
    },
    /** Call right after the UI closes the overlay itself. */
    closed() {
      if (depth === 0) return false;
      depth -= 1;
      try {
        history.back();
      } catch {
        /* the caller already closed the UI; nothing else to undo */
      }
      return true;
    },
    /**
     * Call from the popstate handler.
     * Returns true when the back press was consumed by an overlay.
     */
    handlePop() {
      if (depth === 0) return false;
      depth -= 1;
      if (typeof onClose === "function") onClose();
      return true;
    },
  };
}

/**
 * Single-flight gate for composer submissions.
 *
 * The server does not dedupe: two identical turn/start calls are merged into one
 * turn but the user message is recorded twice and the model sees it twice (E49).
 * `clientUserMessageId` does not suppress them either (E51). The UI's only
 * existing protection is an implementation detail — the input is cleared
 * synchronously, so a second submit reads an empty box — which is easy to lose
 * when the send path changes.
 *
 * Pure on purpose: no timers, no DOM, so the behaviour is unit-testable.
 */
export function createSubmitGate({ staleAfterMs = 45000 } = {}) {
  let inFlight = false;
  let startedAt = 0;
  return {
    get busy() {
      return inFlight;
    },
    /**
     * Returns false when a submission is already running — UNLESS the in-flight
     * one is older than `staleAfterMs`, in which case it is released first.
     *
     * Without that escape hatch the gate is a one-way trap: if a submission hangs
     * (observed in the real UI — opening the attachment picker triggered a submit
     * that never settled), every later send is silently swallowed and the only way
     * back is a page reload.
     */
    begin(now = Date.now()) {
      if (inFlight && now - startedAt > staleAfterMs) {
        console.error('[codex-webui] releasing a stale submit gate after ' + (now - startedAt) + 'ms');
        inFlight = false;
      }
      if (inFlight) return false;
      inFlight = true;
      startedAt = now;
      return true;
    },
    end() {
      inFlight = false;
    },
    /** Runs fn under the gate; returns undefined when already busy. */
    async run(fn) {
      if (!this.begin()) return undefined;
      try {
        return await fn();
      } finally {
        this.end();
      }
    },
  };
}
