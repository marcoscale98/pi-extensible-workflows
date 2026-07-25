# macOS host sleep: guarantees for a local process

## Bottom line

A normal local process cannot guarantee continued execution merely because a Mac laptop is on AC power or because it holds an IOKit assertion. Closing the lid is a **forced sleep** request; Apple explicitly says IOKit cannot prevent forced sleep, only delay it. Continued closed-lid execution is supported only when macOS remains awake in a supported closed-display setup (external display, power, external keyboard/mouse), and even then power-management assertions are requests, not absolute guarantees. A robust Node extension should therefore treat sleep/wake detection and post-wake reconciliation as mandatory, not as a fallback.

## Lid close and closed-display operation

- Apple classifies lid close (like choosing Sleep from the Apple menu) as **forced sleep**, distinct from inactivity-triggered **idle sleep**. Applications cannot prevent forced sleep with IOKit; they can at most delay it briefly ([Apple QA1340](https://developer.apple.com/library/archive/qa/qa1340/_index.html)). AC power does not change that documented rule.
- Apple separately supports using a MacBook with its lid closed and an external display. Its current guidance says a closed-lid laptop must be connected to power and use an external keyboard and mouse; the MacBook Pro guide says the external display and accessories remain usable after the lid closes ([Apple Support](https://support.apple.com/en-us/102501), [MacBook Pro User Guide](https://support.apple.com/guide/macbook-pro/use-an-external-display-apd8cdd74f57/mac)). This is the supported **closed-display/clamshell configuration**, not a promise that any AC-powered laptop stays awake whenever its lid closes.
- Therefore, “lid closed” has two materially different cases: (1) macOS accepts lid close as forced sleep, so ordinary process execution pauses; or (2) a supported closed-display setup keeps the system operational. A process cannot infer case (2) from AC power alone.

## IOKit assertions and `caffeinate`

| Mechanism | Documented effect | What it does not guarantee |
|---|---|---|
| `kIOPMAssertionTypePreventUserIdleSystemSleep` | Prevents system sleep caused by idle user activity; the display may still sleep. | Apple explicitly says the system may still sleep for lid close, Apple-menu sleep, low battery, or other reasons ([Apple IOKit](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep)). |
| `kIOPMAssertionTypePreventSystemSleep` | Makes macOS prefer Dark Wake (or remain there) rather than sleep. | Apple calls assertions “suggestions”; low power or thermal emergencies may still force sleep ([Apple IOKit](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventsystemsleep)). QA1340 additionally states that IOKit cannot prevent forced lid-close sleep. |
| `caffeinate -i` | Prevents **idle** system sleep; this is the command-line counterpart of the user-idle assertion semantics. | Does not cover lid-close forced sleep. |
| `caffeinate -s` | Requests prevention of system sleep and is valid only while on AC power. | AC validity is not a lid-close override or an absolute guarantee. |

The `caffeinate` flag descriptions above come from Apple’s installed [`caffeinate(8)`](x-man-page://8/caffeinate) manual (`man 8 caffeinate`): no flag defaults to idle-sleep prevention; `-i` prevents idle sleep; `-s` prevents system sleep only on AC. The decisive lid-close limit remains Apple QA1340: even an IOKit client that receives `kIOMessageSystemWillSleep` cannot cancel forced sleep—`IOCancelPowerChange` may return success, but the system still sleeps.

## What sleep/wake means for Node.js

- **Process and event loop:** Node.js and libuv document no macOS contract that a process executes during system sleep. Apple’s requirement to notify applications before sleep and after wake, together with its forced-sleep semantics, means code must assume no ordinary event-loop progress while the system is asleep. A surviving process resumes only after macOS wakes; this is not continuous closed-lid execution.
- **Timers:** Node says a timeout callback runs only “as close as possible” to its delay and gives no exact timing guarantee ([Node timers](https://nodejs.org/api/timers.html#scheduling-timers)). Libuv runs timers against the loop’s idea of “now” and invokes overdue work as soon as possible ([libuv timers](https://docs.libuv.org/en/v1.x/timer.html)). On current libuv’s Darwin backend, `uv__hrtime()` uses `mach_continuous_time()` ([libuv source](https://github.com/libuv/libuv/blob/v1.x/src/unix/darwin.c)); Apple documents that clock as advancing while the system sleeps ([Apple Kernel](https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time)). Thus a one-shot timer whose deadline passes during sleep can be eligible promptly after wake. Do not interpret intervals as replaying every missed tick; libuv rearms repeating timers relative to the loop’s current “now.”
- **Child processes:** Node documents spawned children as separate OS processes and `fork()` children as independent Node/V8 instances connected by IPC ([Node child processes](https://nodejs.org/api/child_process.html#child_processforkmodulepath-args-options)). It documents no sleep-specific survival, progress, or ordering guarantee. If the machine sleeps, do not assume either parent or child makes progress; after wake, verify each child is still alive and usable.
- **IPC and I/O:** Node documents local child IPC as a channel and provides `connected`, `disconnect`, `error`, exit, and send-backpressure behavior, but no suspend/resume durability guarantee ([Node child-process IPC](https://nodejs.org/api/child_process.html#subprocesssendmessage-sendhandle-options-callback)). In-memory local channels may still exist after wake if both processes survived, but applications must re-check channel state and reconcile acknowledgements. Network peers, sockets, credentials, mounts, and external services may have changed independently while the host slept; no cited Node/libuv API promises they remain usable.

## Official notification APIs for a Node extension

1. **IOKit: `IORegisterForSystemPower`** — best fit for a headless/native addon that needs the full system transition. Apple’s sample registers a callback, attaches the returned notification-port run-loop source, handles `kIOMessageCanSystemSleep`, `kIOMessageSystemWillSleep`, `kIOMessageSystemWillPowerOn`, and `kIOMessageSystemHasPoweredOn`, then deregisters and destroys all resources ([Apple QA1340](https://developer.apple.com/library/archive/qa/qa1340/_index.html)). The callback must acknowledge `CanSystemSleep`/`SystemWillSleep` with `IOAllowPowerChange` (or cancel idle sleep where appropriate); failing to acknowledge delays sleep by up to 30 seconds. Forced sleep still cannot be canceled.
2. **AppKit: `NSWorkspace.willSleepNotification` / `didWakeNotification`** — simpler for an AppKit/user-session extension. Register on `NSWorkspace.shared.notificationCenter`, not the default notification center ([Apple will-sleep](https://developer.apple.com/documentation/appkit/nsworkspace/willsleepnotification), [Apple did-wake](https://developer.apple.com/documentation/appkit/nsworkspace/didwakenotification)). Apple says a will-sleep observer can delay sleep for up to 30 seconds while handling the notification. This API reports workspace/device sleep and wake but does not offer cancellation.

For a Node native extension, bridge either API onto JavaScript through a thread-safe async handoff; do not invoke V8/Node APIs directly from an arbitrary native callback. IOKit is the clearer choice for a daemon-like extension and distinguishes “will power on” from “has powered on”; `NSWorkspace` is convenient when AppKit and a logged-in workspace are already appropriate.

## Design consequence: prevent vs recover

- **Continuing while closed:** possible only if macOS stays operational (for example, supported clamshell mode). Assertions can reduce idle/system-sleep likelihood but cannot supply an unconditional lid-close guarantee.
- **Detecting wake and resuming safely:** is a separate, achievable guarantee. Subscribe to an official wake API, record durable task state before/through normal operation, and on `didWake`/`SystemHasPoweredOn` recompute elapsed time, check child PIDs and IPC health, reconnect external resources, and reconcile work by durable IDs/acknowledgements. The wake notification says the host resumed; it does not certify that dependencies or in-flight operations remained valid.

## Primary sources

- Apple, [Technical Q&A QA1340: Registering and unregistering for sleep and wake notifications](https://developer.apple.com/library/archive/qa/qa1340/_index.html)
- Apple, [IOKit assertion: PreventUserIdleSystemSleep](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep) and [PreventSystemSleep](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventsystemsleep)
- Apple, [`NSWorkspace` sleep/wake notifications](https://developer.apple.com/documentation/appkit/nsworkspace/willsleepnotification)
- Apple, [`mach_continuous_time`](https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time)
- Apple, installed `caffeinate(8)` manual
- Node.js, [Timers](https://nodejs.org/api/timers.html) and [Child process](https://nodejs.org/api/child_process.html)
- libuv, [Timer handle documentation](https://docs.libuv.org/en/v1.x/timer.html) and [Darwin clock source](https://github.com/libuv/libuv/blob/v1.x/src/unix/darwin.c)
