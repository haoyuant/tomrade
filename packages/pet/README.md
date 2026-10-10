# `@tomradex/pet`

This optional Cordis plugin owns `ctx.pet` and the complete pet lifecycle. Its
settings section chooses `embedded` or `desktop`; setting `enabled` hides the
feature without unloading the settings card, while the Plugins-sheet switch
unloads the service, section, contribution, channels, listeners, timers and
desktop window.

The plugin listens to the typed main-process `agent/event` stream. Every turn
is a new run, `thinking` until its first output (a text delta, emitted block,
card or tool call) and `working` from then until it ends; a pending question or
an `asked` run is `waiting`; a turn that ends shows `success` or `error` for 3
seconds and then rests at `idle` — the pet reflects the turn, not the whole
thread; cancellation is `idle` at once. Both the embedded stage and the desktop pet
show the thread the assistant panel is showing — the panel reports it through
`agent.showing` — so an old thread still waiting for an answer never holds the
pet; leaving the project keeps the last one.

The desktop pet stays where it is put: dragging its opaque pixels moves the
window, and a window reopened for a new size or setting returns to the last
spot in this session. `prefers-reduced-motion` holds each image's first frame.

## Pets and their images

Each mood is one still or animated image (GIF, WebP, APNG, PNG, JPEG or AVIF),
played with its own frame timings by an `ImageDecoder` player — the renderer's
for the embedded stage, `assets/desktop.html` for the desktop window. The
image's content box is fitted to 90% of the stage height, bottom-aligned, so
every state fills the stage alike whatever its canvas size.

The built-in pet (`assets/<mood>.webp`, memes cropped to their content) is
profile `default`: it can't be changed or removed, so the user can always go
back to it. Settings › Pet lets the user make more from their own images; a
profile's state without an image shows the built-in pet's. Profiles live under
`config.profilesDir` (`${userData}/pet-profiles` in the app), one folder per
profile with `profile.json` and the original image files, plus `profiles.json`
naming the one in use. Nothing there is synced. The renderer measures an
image's visible area when it is chosen and sends it as `box`; the main process
reads the type from the bytes and caps each image at 8 MB.

The Electron implementation forwards mouse movement through ignored windows
on macOS and Windows. The pet document alpha-tests its current canvas frame:
transparent pixels pass through, while opaque cat pixels are interactive and
start a pointer drag, sent to the plugin as `move` messages that it applies
with `setPosition`. Electron does not provide forwarded moves on Linux, so the
tightly sized window stays interactive there. Native Wayland does not allow
programmatic placement of top-level windows; the surface host reports that
capability as unavailable and the canvas falls back to a native drag region.
