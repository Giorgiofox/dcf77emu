# dcf77emu

Cross-platform Python emulator of the **DCF77** longwave time signal (77.5 kHz)
using nothing but a standard PC audio output. Lets you synchronize a
radio-controlled clock (Citizen, Junghans, Braun, Casio Wave Ceptor, …)
without a real DCF77 transmitter or hardware modulator.

Runs on macOS, Linux and Windows. Managed entirely with [uv](https://docs.astral.sh/uv/).

## How it works

DCF77 broadcasts the official German atomic time on a **77.5 kHz** longwave
carrier. That frequency is far above any consumer sound card's Nyquist
limit (24 kHz at 48 kHz sample rate), so it cannot be played as audio.

The trick: **DAC zero-order-hold imaging**. When a digital-to-analog
converter outputs a sampled tone at frequency `f`, it also produces
spectral mirror images at `k·fs ± f` for every integer `k`. By picking
`f` so that one of those images lands on 77.5 kHz, the audio cable
radiates a tiny but real 77.5 kHz field. A radio-controlled clock
placed within a few centimeters of the jack picks it up.

At a 48 kHz sample rate the math works out to:

```
2·fs − f = 77500   ⇒   f = 96000 − 77500 = 18500 Hz
```

So the emulator emits **18.5 kHz** out of the audio jack (a thin, high
whistle near the edge of adult hearing) and the DAC's image at
`2·48000 − 18500 = 77500 Hz` is what the clock actually receives.

DCF77 amplitude modulation is reproduced on top of this carrier by
attenuating it to ~15 % during the first 100 ms (bit 0) or 200 ms
(bit 1) of every second. Second 59 carries no pulse so the clock can
align on the minute boundary.

NTP synchronization runs in a background thread so the transmitted time
stays accurate even if the local system clock drifts.

## Install

Install [uv](https://docs.astral.sh/uv/) once:

```sh
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Clone and sync:

```sh
git clone https://github.com/Giorgiofox/dcf77emu.git
cd dcf77emu
uv sync
```

## Run

```sh
uv run dcf77emu                          # use system timezone
uv run dcf77emu -t Europe/Rome           # override timezone
uv run dcf77emu --list-devices           # list audio outputs
uv run dcf77emu -d 3                     # pick output device by index
uv run dcf77emu -w sine                  # cleaner spectrum, weaker field
uv run dcf77emu -w square                # default, strongest field
uv run dcf77emu -w pulse                 # narrow-pulse train, loudest audible
uv run dcf77emu --no-ntp                 # disable NTP, use system clock only
uv run dcf77emu --ntp-server time.nist.gov
uv run dcf77emu -c 18500                 # force custom audio carrier
uv run dcf77emu -r 96000                 # force sample rate
```

Live status line during operation:

```
sample rate:   48000 Hz
audio carrier: 18500.00 Hz  (image (k=2, sign=-))
wave shape:    square
target RF:     77500 Hz  -> DCF77
timezone:      Europe/Rome
ctrl-c to stop
2026-05-14 16:23:07 Europe/Rome  sec=07 bit=1 pulse=200ms  NTP=  +12.3 ms
```

## Practical setup

1. Set **system volume to maximum**.
2. Plug in **headphones or a 3.5 mm cable** — the cable is the antenna.
   Built-in laptop speakers radiate far less.
3. Lay the clock on the cable or within ~5 cm of the jack.
4. Put the clock in **manual reception mode** (consult its manual). It
   typically takes 2–5 minutes to lock on; some clocks need a full
   minute frame plus parity verification.
5. If your clock shows a signal-strength indicator (L / M / H), aim for
   M or H by repositioning the cable and clock.

## Wave shapes

| Shape   | Spectrum                        | Field at 77.5 kHz | Audible noise           |
| ------- | ------------------------------- | ----------------- | ----------------------- |
| sine    | single tone                     | weakest           | quietest                |
| square  | odd harmonics                   | strong (default)  | high whistle            |
| pulse   | dense harmonic content          | strongest         | loudest, harsher        |

If your clock won't lock with the default `square`, try `pulse`. If the
audible tone bothers you and the field is already enough, drop to `sine`.

## CLI reference

```
--timezone, -t       IANA timezone (default: system timezone)
--carrier,  -c       Force audio carrier in Hz (default: auto)
--wave,     -w       Wave shape: sine | square | pulse (default: square)
--device,   -d       Output device index (see --list-devices)
--sample-rate, -r    Force sample rate (default: 48000)
--list-devices       List audio devices and exit
--ntp-server         NTP server (default: pool.ntp.org)
--ntp-refresh        NTP refresh interval in seconds (default: 3600)
--no-ntp             Disable NTP sync
```

## Files

- `dcf77.py` — protocol encoder (BCD, parity, minute frame layout)
- `signal_gen.py` — sine / square / pulse generator with DCF77 envelope
- `timesync.py` — background NTP client
- `main.py` — CLI, audio stream, second-by-second scheduling

## Disclaimer

This emulator radiates an extremely low-power field measured in nanowatts,
intended for synchronizing clocks at desk distance. It is not a
transmitter and is not intended for broadcasting. Local radio regulations
may apply; you are responsible for compliant use.

## License

MIT.
