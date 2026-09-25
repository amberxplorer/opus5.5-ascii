# 赤い糸 · a beautiful thread

## [▶ Play the live demo](https://amberxplorer.github.io/opus5.5-ascii/)

A ninety-second audiovisual piece made only of characters. Every frame is a grid of
glyphs over one unchanging background colour, and every sound is synthesized in the
browser from the score in `src/synth.js`. Words appear once, on the opening title card.

Open `index.html` in a browser with WebGL2 (any current Chrome, Edge, Firefox or Safari),
then click, tap or press Enter. Headphones help.

| key | does |
| --- | --- |
| Enter / click | play (and replay after the end) |
| Space | pause / resume |
| F | fullscreen |
| ← / → | seek 5 s |
| R | restart |

## What happens

| time | picture | music (128 BPM, 48 bars) |
| --- | --- | --- |
| 0:00 | title card; the ring of beads collapses into one bead | drone, glass chimes |
| 0:05 | the bead pulls a red thread taut; every plucked note strings a bead and sets the thread ringing | plucked string (Karplus-Strong), heartbeat, pads |
| 0:15 | threads multiply into a loom, weave into cloth, and the cloth curls up into a tunnel | build: filtered kick, arpeggio, riser, snare roll |
| 0:30 | flight down the woven tunnel, rings on every beat, a square section, a twist | drop in D major, lead hook |
| 0:45 | out of the tunnel: the thread has tied itself into a trefoil knot; bells light the beads on it | breakdown, bell melody |
| 1:00 | the knot bursts into a galaxy of beads, then a mandala, then merging metaballs, then cuts on every beat | second drop, lifted to E major |
| 1:15 | two figures on a rooftop under a crescent moon, their tails forming a heart, tied with the red thread | outro; the last chord rings out |
| 1:28 | everything dissolves inward until a single bead remains | final chime and heartbeat |

## How it works

- **Sound** (`src/synth.js`). A sample-level synthesizer renders the whole track in a Web
  Worker while the play screen is up (about 3–4 s on a laptop): Karplus-Strong plucks
  tuned with an allpass, PolyBLEP supersaw pads, FM bells, synthesized drums, a Dattorro
  plate reverb, ping-pong delay, kick sidechain, and a look-ahead limiter. It also returns
  per-instrument envelopes and the score, so the visuals react to the actual notes.
- **Text renderer** (`src/engine.js`). WebGL2 in three passes. Scene shaders (raymarched
  knot, woven tunnel, mandala, metaballs, nebula, moon) and a hidden vector canvas render
  at 2×4 samples per character cell. A cell pass picks each cell's glyph: cells with edges
  are matched against glyph shape vectors from a symbol-only alphabet, and flat cells take
  a density ramp. A final pass draws the glyphs from an atlas. Beads, stars and particles
  are placed as explicit characters on top.
- **Timeline** (`src/scenes.js`). Every frame is a pure function of the music clock, read
  from the audio output timestamp, so picture and sound stay locked and seeking works.

## Building and checking

`index.html` is generated; edit `src/` and run `node build.mjs`.

- `node tools/audio.mjs [dir]` renders the track in Node, writes `track.wav` and
  `spectrogram.png`, and prints levels per section and per instrument.
- `node tools/shoot.mjs <dir> 1280x720 12.5,33,80` captures frames headlessly
  (`sheet:` in front of the times makes a contact sheet).
- `node tools/video.mjs out.mp4 track.wav 720x1280 30 6` renders an MP4 frame by frame
  (1 s of the play screen, then the whole piece), muxed with the WAV from `tools/audio.mjs`.
- `node tools/play.mjs <seconds> [startAt]` plays the page for real in headless Chromium
  and reports the clock, frame rate and any console errors.

The monospace face (JetBrains Mono) and the title face (Shippori Mincho) load from Google
Fonts; without a network connection the page falls back to local fonts. Viewers with
reduced motion enabled get the piece without shakes, glitches or flashes.
