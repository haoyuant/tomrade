# `@tomradex/pet`

This optional Cordis plugin owns `ctx.pet` and the complete pet lifecycle. Its
settings section chooses `embedded` or `desktop`; setting `enabled` hides the
feature without unloading the settings card, while the Plugins-sheet switch
unloads the service, section, contribution, channels, listeners, timers and
desktop window.

The plugin listens to the typed main-process `agent/event` stream. A run starts
as `thinking`; tool activity, emitted blocks and text deltas are `working`; a
pending question or an `asked` run is `waiting`; completion is `success` for
2.6 seconds; failure is `error`; cancellation is `idle`. The embedded stage
asks for the selected thread. The desktop pet considers every observed thread,
using `error > waiting > working > thinking > success > idle`, then latest
event and thread id as deterministic tie-breakers.

Desktop roaming occurs only while that aggregate state is idle. The sprite
switches to `walk` for the movement and returns to the task state at rest.
`prefers-reduced-motion` freezes sprite animation and is reported to the plugin
so window movement stops too.

The Electron implementation forwards mouse movement through ignored windows
on macOS and Windows. The pet document alpha-tests its current canvas frame:
transparent pixels pass through, while opaque cat pixels become a native drag
region. Electron does not provide forwarded moves on Linux, so the tightly
sized window stays interactive there. Native Wayland does not allow reliable
programmatic placement of top-level windows; the surface host reports that
capability as unavailable and the pet remains stationary, while X11 can roam.
