# dcf77emu

Cross-platform emulator of longwave radio time signals using nothing but a
standard audio output. Syncs radio-controlled clocks and watches (Casio,
Citizen, Junghans, Braun, Seiko ...) without a real transmitter or hardware
modulator.

Supports six stations:

| Station | Region | Carrier | Timezone |
| ------- | ------ | ------- | -------- |
| `dcf77` | Germany / continental Europe | 77.5 kHz | CET/CEST |
| `msf`   | England / UK | 60 kHz | UTC + summer flag |
| `wwvb`  | USA | 60 kHz | UTC |
| `jjy60` | Japan (west, south) | 60 kHz | JST |
| `jjy40` | Japan (north, east) | 40 kHz | JST |
| `bpc`   | China (experimental) | 68.5 kHz | CST |

Comes in two flavours:

- **`web/`** a zero-install browser app (Web Audio). Open it on a phone, no
  Python needed. Live spectrum, frame view, online clock calibration, installs
  as a PWA. This is the easiest way to use it.
- **Python CLI** (this README) for desktop use with NTP sync.

## How it works

Radio clocks lock onto a longwave carrier far above any sound card's Nyquist
limit (24 kHz at 48 kHz sample rate), so it cannot be played as audio directly.
The working trick:

**Harmonic mode (default).** Emit a square tone at `carrier / k` (default
`k = 4`) at **low amplitude**. The speaker and amplifier are nonlinear, so they
generate the k-th harmonic, which lands **exactly** on the station carrier. For
DCF77 that means a 19375 Hz tone whose 4th harmonic is 77500 Hz.

Amplitude is kept low on purpose (default `0.05`). A loud full-scale carrier
overdrives the output and buries the harmonic in distortion noise. A few
percent of full scale is plenty.

Each station's protocol amplitude-keys that tone every second to transmit the
time frame (BCD time, parity, markers). DCF77/WWVB/JJY reduce the carrier;
MSF switches it fully off (OOK); BPC uses pulse-width symbols.

**Image mode (`--mode image`)** emits a sub-Nyquist tone and relies on DAC
zero-order-hold spectral images. It rarely lands exactly on the carrier (for
DCF77 the nearest image is 78875 Hz, 1375 Hz off) and a narrow receiver will
not lock, so it is no longer the default. Kept for experimentation.

NTP synchronization runs in a background thread so the transmitted time stays
accurate even if the system clock drifts.

## Install

### Option A: uv (recommended)

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh    # once, macOS/Linux
git clone https://github.com/Giorgiofox/dcf77emu.git
cd dcf77emu
uv sync
```

### Option B: pip + venv

```sh
git clone https://github.com/Giorgiofox/dcf77emu.git
cd dcf77emu
python3 -m venv .venv
source .venv/bin/activate         # Windows: .venv\Scripts\activate
pip install numpy sounddevice tzlocal ntplib
```

Then run `python3 main.py ...` wherever this README shows `uv run dcf77emu ...`.

### Linux system dependency

`sounddevice` wraps PortAudio:

```sh
sudo apt install -y libportaudio2          # Debian/Ubuntu
ldconfig -p | grep portaudio               # must show libportaudio.so.2
```

Fedora/RHEL: `sudo dnf install portaudio`. Arch: `sudo pacman -S portaudio`.
macOS and Windows wheels bundle PortAudio.

## Run

```sh
uv run dcf77emu                          # DCF77, harmonic k=4, low amp, NTP on
uv run dcf77emu -s wwvb                   # WWVB (USA)
uv run dcf77emu -s jjy60                  # JJY 60 kHz (Japan)
uv run dcf77emu -s msf                    # MSF (UK)
uv run dcf77emu -s bpc                    # BPC (China, experimental)
uv run dcf77emu --list-devices            # list audio outputs
uv run dcf77emu -d 3                      # pick output device by index
```

The station picks its own timezone automatically. Override with `-t` only if
you need to (for example a watch set to a different home city).

### Amplitude, harmonic, wave

```sh
uv run dcf77emu -a 0.1                     # louder if the clock will not lock
uv run dcf77emu --harmonic-k 5             # 5th harmonic (lower, more audible)
uv run dcf77emu -w square                  # square (default, rich harmonics)
uv run dcf77emu -w pulse                   # densest harmonics, loudest
uv run dcf77emu -w sine                    # cleanest, weakest
uv run dcf77emu --lowshelf                 # cut audible band <12 kHz
```

### NTP

```sh
uv run dcf77emu --no-ntp                   # system clock only
uv run dcf77emu --ntp-server time.nist.gov
uv run dcf77emu --ntp-refresh 600
```

Live status line:

```
station:       DCF77 / Mainflingen (Germany)
sample rate:   48000 Hz
audio carrier: 19375.00 Hz  (harmonic (k=4))  amp=0.0500
wave shape:    square
target RF:     77500 Hz  -> DCF77
timezone:      Europe/Berlin
2026-06-12 16:23:07 Europe/Berlin  sec=07 red  200ms  NTP=  +12.3 ms
```

## Practical setup

1. Set **system volume to maximum**.
2. Plug in **headphones or a 3.5 mm cable** (the cable is the antenna).
3. Put the clock in **manual reception mode** and lay it within a few cm of the
   jack or speaker. Casio receives near the 9 o'clock edge of the case.
4. Give it 2 to 10 minutes. A clean uninterrupted run matters more than volume;
   the clock verifies a full minute frame plus parity before accepting.
5. If it will not lock: raise `-a`, try `-w pulse`, or change `--harmonic-k`.
   Different hardware radiates a different harmonic best.

## Files

- `dcf77.py` DCF77 protocol encoder (BCD, parity, minute frame)
- `stations.py` all six station encoders, returning per-second modulation
- `signal_gen.py` wave generators, lowshelf biquad, envelope renderer
- `timesync.py` background NTP client
- `main.py` CLI, carrier picker (harmonic + image), audio stream, scheduler
- `web/` browser app (Web Audio), see `web/`

## Disclaimer

Radiates an extremely low-power field measured in nanowatts, for synchronizing
clocks at desk distance. Not a transmitter. Local radio regulations may apply;
you are responsible for compliant use.

## License

MIT. Built by Giorgio Campiotti.
