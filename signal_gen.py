"""Audio signal generation for DCF77 emulation.

DCF77 transmits at 77.5 kHz. We get audio hardware to emit that frequency
using one of two mechanisms depending on the available sample rate:

  direct  : sample rate >= 155 kHz so 77.5 kHz < Nyquist. We synthesize the
            carrier directly. (Rare, requires high-end DAC.)

  image   : sample rate < 155 kHz so 77.5 kHz cannot be represented in the
            digital signal. Instead we synthesize a sub-Nyquist tone at
            `carrier_hz` and rely on DAC zero-order-hold spectral images
            at k*fs +/- carrier_hz to put a copy on 77.5 kHz. For fs=48k
            and carrier=18500 the k=2 image lands exactly on 77.5 kHz.

Wave shape options:

  sine    : clean spectrum, single tone, easiest on ears.
  square  : rich odd-harmonic spectrum. Many of those harmonics alias back
            into baseband at fs=48k (square at 18.5 kHz has 3rd at 55.5 kHz
            -> aliases to 7.5 kHz, etc.), creating broadband content that
            tends to leak more energy through real DAC reconstruction
            filters near 77.5 kHz. Usually gives a stronger field at the
            radio-controlled clock.
  pulse   : narrow positive pulse once per period, even more harmonic
            content. Loudest audible, strongest leakage.

DCF77 amplitude modulation: full carrier most of the second, reduced to
~15% during the first 100 ms (bit 0) or 200 ms (bit 1) of each second.
Second 59 carries no pulse.
"""

from __future__ import annotations

import numpy as np


FULL_AMP = 0.98
REDUCED_AMP = 0.147


def _phase_array(samples: int, freq_hz: float, sample_rate: int,
                 phase: float) -> tuple[np.ndarray, float]:
    t = np.arange(samples, dtype=np.float64) / sample_rate
    angle = 2.0 * np.pi * freq_hz * t + phase
    next_phase = (phase + 2.0 * np.pi * freq_hz * samples / sample_rate) % (2.0 * np.pi)
    return angle, next_phase


def sine_wave(samples: int, freq_hz: float, sample_rate: int,
              phase: float = 0.0) -> tuple[np.ndarray, float]:
    angle, next_phase = _phase_array(samples, freq_hz, sample_rate, phase)
    return np.sin(angle).astype(np.float32), next_phase


def square_wave(samples: int, freq_hz: float, sample_rate: int,
                phase: float = 0.0) -> tuple[np.ndarray, float]:
    angle, next_phase = _phase_array(samples, freq_hz, sample_rate, phase)
    return np.sign(np.sin(angle)).astype(np.float32), next_phase


def pulse_wave(samples: int, freq_hz: float, sample_rate: int,
               phase: float = 0.0, duty: float = 0.1) -> tuple[np.ndarray, float]:
    angle, next_phase = _phase_array(samples, freq_hz, sample_rate, phase)
    frac = (angle / (2.0 * np.pi)) % 1.0
    wave = np.where(frac < duty, 1.0, -1.0).astype(np.float32)
    return wave, next_phase


def quant_sine_wave(samples: int, freq_hz: float, sample_rate: int,
                    phase: float = 0.0, levels: int = 8) -> tuple[np.ndarray, float]:
    """Sine quantized to `levels` discrete amplitude steps.

    Quantization injects odd harmonics: cleaner than square, richer than sine.
    Useful for harmonic-mode carriers where the k-th harmonic must reach
    77.5 kHz via speaker/cable nonlinearity. Inspired by DCF77.js distorter.
    """
    angle, next_phase = _phase_array(samples, freq_hz, sample_rate, phase)
    s = np.sin(angle)
    step = 2.0 / levels
    wave = (np.round(s / step) * step).astype(np.float32)
    return wave, next_phase


WAVE_FUNCS = {
    "sine": sine_wave,
    "square": square_wave,
    "pulse": pulse_wave,
    "quant": quant_sine_wave,
}


def lowshelf_attenuate(x: np.ndarray, sample_rate: int,
                       cutoff_hz: float = 12000.0, gain_db: float = -24.0
                       ) -> np.ndarray:
    """Single-pole low-shelf attenuation: drop content below `cutoff_hz`.

    Reduces audible whistle while leaving the high carrier and its harmonics
    intact. RBJ biquad lowshelf, Q=0.707. Inspired by DCF77.js BiquadFilter.
    """
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * cutoff_hz / sample_rate
    cos_w0 = np.cos(w0)
    sin_w0 = np.sin(w0)
    alpha = sin_w0 / (2.0 * 0.707)
    sqrtA = np.sqrt(A)

    b0 = A * ((A + 1) - (A - 1) * cos_w0 + 2 * sqrtA * alpha)
    b1 = 2 * A * ((A - 1) - (A + 1) * cos_w0)
    b2 = A * ((A + 1) - (A - 1) * cos_w0 - 2 * sqrtA * alpha)
    a0 = (A + 1) + (A - 1) * cos_w0 + 2 * sqrtA * alpha
    a1 = -2 * ((A - 1) + (A + 1) * cos_w0)
    a2 = (A + 1) + (A - 1) * cos_w0 - 2 * sqrtA * alpha

    b = np.array([b0, b1, b2]) / a0
    a = np.array([1.0, a1 / a0, a2 / a0])

    y = np.zeros_like(x, dtype=np.float32)
    x1 = x2 = y1 = y2 = 0.0
    for i in range(len(x)):
        xi = float(x[i])
        yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
        x2, x1 = x1, xi
        y2, y1 = y1, yi
        y[i] = yi
    return y


def build_second(bit: int, second: int, carrier_hz: float, sample_rate: int,
                 phase: float = 0.0, wave_kind: str = "square"
                 ) -> tuple[np.ndarray, float]:
    """Build one second of audio with the DCF77 amplitude envelope applied."""
    if wave_kind not in WAVE_FUNCS:
        raise ValueError(f"unknown wave_kind: {wave_kind}")
    total = sample_rate
    wave, next_phase = WAVE_FUNCS[wave_kind](total, carrier_hz, sample_rate, phase)

    envelope = np.full(total, FULL_AMP, dtype=np.float32)
    if second != 59:
        pulse_ms = 200 if bit else 100
        pulse_samples = int(round(sample_rate * pulse_ms / 1000.0))
        envelope[:pulse_samples] = REDUCED_AMP

    return wave * envelope, next_phase
