// The Android back gesture must close an open drawer/dialog instead of leaving
// the app — and must never trap the user (a stuck back button is worse than the
// original problem). Pure state machine, so it is testable without a browser.
import { createOverlayBackGuard } from "../app/public/ui-core.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// Minimal history stub: a stack plus a pop that fires popstate like the browser.
function fakeHistory() {
  const stack = [{ base: true }];
  const listeners = [];
  return {
    stack,
    pushStateCalls: 0,
    backCalls: 0,
    pushState(state) { this.pushStateCalls += 1; stack.push(state); },
    back() {
      this.backCalls += 1;
      if (stack.length > 1) stack.pop();
      for (const fn of listeners) fn({ state: stack[stack.length - 1] });
    },
    onPop(fn) { listeners.push(fn); },
  };
}

// --- back closes the drawer ------------------------------------------------
{
  const history = fakeHistory();
  let closes = 0;
  const guard = createOverlayBackGuard({ history, onClose: () => { closes += 1; } });
  history.onPop(() => guard.handlePop());

  check("opening pushes exactly one history entry", [guard.opened(), history.pushStateCalls, guard.depth], [true, 1, 1]);
  history.back(); // the user pressed Android back
  check("back closes the overlay", [closes, guard.depth], [1, 0]);
  check("and the next back is not consumed (app can navigate)", guard.handlePop(), false);
}

// --- closing from the UI keeps history balanced ----------------------------
{
  const history = fakeHistory();
  let closes = 0;
  const guard = createOverlayBackGuard({ history, onClose: () => { closes += 1; } });
  guard.opened();
  guard.closed(); // user tapped X
  check("self-close pops the pushed entry", [history.backCalls, guard.depth], [1, 0]);
  check("self-close does not fire the close callback again", closes, 0);
  check("history depth is back to the base entry", history.stack.length, 1);
}

// --- nested overlays close one at a time ----------------------------------
{
  const history = fakeHistory();
  let closes = 0;
  const guard = createOverlayBackGuard({ history, onClose: () => { closes += 1; } });
  // (this block previously forgot to wire popstate — the assertions were testing
  //  the test harness, not the guard)
  history.onPop(() => guard.handlePop());
  guard.opened();
  guard.opened();
  history.back();
  check("first back closes one overlay", [closes, guard.depth], [1, 1]);
  history.back();
  check("second back closes the other", [closes, guard.depth], [2, 0]);
}

// --- closing something that was never opened is a no-op -------------------
{
  const history = fakeHistory();
  const guard = createOverlayBackGuard({ history, onClose() {} });
  check("closed() with nothing open does not touch history", [guard.closed(), history.backCalls], [false, 0]);
  check("handlePop() with nothing open lets the app handle it", guard.handlePop(), false);
}

// --- environments without history must not throw --------------------------
{
  const guard = createOverlayBackGuard({ history: undefined, onClose() {} });
  check("opened() without history is a safe no-op", [guard.opened(), guard.depth], [false, 0]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
