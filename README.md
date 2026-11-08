# MixDeck SQ

Allen & Heath SQ-5 control with a modern UI. Fork of MixDeck (X32). Installable web app (PWA) for laptop, tablet and phone. Runs in Docker.

Also works with SQ-6 and SQ-7 (same protocol), not tested.

## Features

- **Mix**: all strips (48 inputs, 8 FX returns, 12 aux, 4 FX sends, 3 matrix, LR, 8 DCA), pan, mute, sends on fader, favorites, undo. Channel panel: input (gain, 48 V, trim, polarity, HPF, delay, insert on), gate, EQ (4-band PEQ), comp, sends.
- **DiGiCo view**: fader banks of up to 12, a touch column per channel (input, gain with 48 V and phase, HPF, insert, EQ, gate, comp, sends, pan, name), a rotary per fader (gain, HPF, pan or a send), Flip to faders, Hide faders. Tap a section to open it in a window. **Sync select with console** follows the console Sel keys (after Learn Sel).
- **Follow mode** (Follow button): shows the channel selected on the SQ, full screen. Tabs for Channel, Input, Gate, Comp, EQ, Sends. It can also follow the last control moved on the console and open that control's page.

- **Meters and RTA**: strip meters, gate lights, comp gain reduction, RTA behind the EQ graph. The SQ sends these over UDP in a format that is not published; the app uses a **guessed** layout (see below).

Not in this fork: solo/PAFL, scenes, FX, patching, console link, MIDI controllers.

## Setup on the SQ

1. Utility → General → MIDI: note the MIDI channel. Set **NRPN Fader Law** to **Linear Taper**.
2. Network: the app host must reach the SQ on TCP 51325 and TCP 51326.
3. In the app: Settings → Console: IP address, MIDI channel.
4. Settings → Console select → **Learn Sel**. Press SEL on input 1, 2 and 3 when the app asks. Do this once per firmware version.

## Protocols

- **TCP 51325, SQ MIDI protocol** (Allen & Heath, Issue 5, firmware 1.5.0+): faders, mutes, pan/balance, sends, assigns, DCA, mute groups. Documented.
- **TCP 51326, MixPad protocol**: names, preamp, HPF, gate, PEQ, comp, delay, insert, select. Allen & Heath does not publish it. Frames come from [hrueger/allen-heath-sq-tools](https://github.com/hrueger/allen-heath-sq-tools) (MIT), from SQ-5 firmware 1.6 traffic. The select message is not known, so the app learns it. Turn this connection off in Settings if it causes problems; Mix and DiGiCo then show faders, mutes, pan and sends only.

Not yet tested on hardware. Items to check on a console:
- Name length (6 characters assumed) and live name updates (only read at connect).
- Comp threshold, makeup and gate/trim scaling; PEQ width encoding; HF shape values.
- PEQ and comp on aux and LR (addresses inferred).
- Meter and RTA packet layout (a guess). Settings → Meters and RTA shows packet stats and lets you edit the layout (JSON). To help decode it: play a tone into one input, type a note (for example "-18 dB tone on input 1"), click **Record 10 s**, then **Download recording** and send the file.

Meters need UDP from the SQ to the app. The compose file uses `network_mode: host` for this. `SQ_UDP_PORT` sets a fixed local UDP port (0 = any).

## Run on the Pi (CasaOS)

1. Push this folder to `github.com/daviied/mixdeck-sq`. The GitHub Action builds `ghcr.io/daviied/mixdeck-sq:latest` (arm64, armv7, amd64).
2. Make the package public (GitHub → Packages → mixdeck-sq → Settings), or log in to GHCR on the Pi.
3. CasaOS: **Custom Install → Import**, paste `docker-compose.yml`, set `APP_PASSWORD`, `SESSION_SECRET`, `SQ_IP`.
4. Open `http://<pi>:8080`.
5. Put nginx in front with HTTPS (needed for PWA install). `proxy_pass` plus `X-Forwarded-Proto`. The app sends `X-Accel-Buffering: no` for its event stream.

## Try it without a console

```bash
cd app && APP_PASSWORD=test SQ_MOCK=1 DATA_DIR=../.data python server.py
```

Runs a simulated SQ. In demo mode, Learn Sel presses the simulated Sel keys for you. Tests: `python tests/test_backend.py`.

## How it works

- `app/sq.py` maps both SQ protocols onto X32-shaped paths (`/ch/01/mix/fader`), so the UI is shared with MixDeck. Aux 1-12 are `/bus/01-12`, FX sends 1-4 are `/bus/13-16`.
- `app/sim.py` is the simulator. `app/server.py` serves the UI, pushes changes on Server-Sent Events and takes writes in batches.
