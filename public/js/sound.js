'use strict';

/*
 * Audio cues for the host screen: a ticking countdown while a question runs, a
 * sting when time expires, and a fanfare with applause on the leaderboard.
 *
 * Everything is synthesised through the Web Audio API rather than shipped as
 * files. That keeps the repository free of binary assets and of anyone else's
 * copyrighted audio, avoids a round trip before the first tick, and means the
 * content security policy needs no exception for a media host.
 *
 * The countdown is pitched rather than a plain click: a low pulse on the beat
 * with a bright alternating pluck over it, which reads as a game-show clock.
 * The last five seconds double in tempo and step up a third, so the room hears
 * the pressure rise without having to watch the number.
 */

const TQSound = (() => {
  const MUTE_KEY = 'tq.muted';

  // Equal temperament, A4 = 440. Named so the phrases below stay readable.
  const HZ = {
    C3: 130.81, G3: 196.00, A3: 220.00, C4: 261.63, E4: 329.63,
    G4: 392.00, A4: 440.00, C5: 523.25, D5: 587.33, E5: 659.25,
    G5: 783.99, A5: 880.00, C6: 1046.50, D6: 1174.66, E6: 1318.51,
  };

  let ctx = null;
  let master = null;
  let applauseBuf = null;
  let muted = false;
  let beat = 0;

  try {
    muted = localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    /* storage disabled; default to audible */
  }

  /**
   * Browsers refuse to start an AudioContext until the user has interacted
   * with the page, so this is called lazily and again on the first gesture.
   */
  function ready() {
    if (muted) return null;
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try {
        ctx = new Ctor();
      } catch {
        return null;
      }
      master = ctx.createGain();
      master.gain.value = 0.85;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx.state === 'running' ? ctx : null;
  }

  function unlock() {
    if (muted) return;
    const c = ready();
    // Build the applause while the room is still filling up. It costs a few
    // tens of milliseconds, and this keeps that off the leaderboard reveal.
    if (c && !applauseBuf) {
      const build = () => { if (!applauseBuf) applauseBuf = buildApplause(c); };
      if (window.requestIdleCallback) window.requestIdleCallback(build, { timeout: 2000 });
      else setTimeout(build, 400);
    }
  }

  for (const event of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(event, unlock, { passive: true });
  }

  /**
   * One shaped note. `glideTo` bends the pitch over the note's life, which is
   * what gives the bass pulse its thump and the sting its fall.
   */
  function note(c, {
    freq, at = 0, dur = 0.15, type = 'triangle', gain = 0.2,
    glideTo = null, cutoff = null, attack = 0.006,
  }) {
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const amp = c.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);

    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let tail = amp;
    if (cutoff) {
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      amp.connect(filter);
      tail = filter;
    }

    osc.connect(amp);
    tail.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // --- countdown --------------------------------------------------------------

  /** A single beat of the countdown: bass pulse plus a bright pluck over it. */
  function hit(c, { at, high, loud }) {
    note(c, {
      freq: loud ? HZ.A3 : HZ.G3,
      glideTo: loud ? HZ.C3 : HZ.C3,
      at,
      dur: 0.13,
      type: 'sine',
      gain: loud ? 0.30 : 0.20,
      cutoff: 900,
    });
    note(c, {
      freq: high,
      at,
      dur: loud ? 0.10 : 0.07,
      type: 'triangle',
      gain: loud ? 0.20 : 0.11,
      cutoff: 5000,
    });
  }

  /**
   * Called once per remaining second. The urgent variant plays an extra
   * off-beat hit half a second later, doubling the tempo for the run-in.
   */
  function tick(urgent = false) {
    const c = ready();
    if (!c) return;
    beat += 1;

    if (urgent) {
      hit(c, { at: 0, high: HZ.E6, loud: true });
      hit(c, { at: 0.5, high: HZ.C6, loud: true });
      return;
    }
    // Alternating pitch is what makes it read as tick-tock rather than a beep.
    hit(c, { at: 0, high: beat % 2 ? HZ.C6 : HZ.A5, loud: false });
  }

  // --- time up ----------------------------------------------------------------

  /** A falling four-note sting, landing on a low note that rings briefly. */
  function timeUp() {
    const c = ready();
    if (!c) return;
    beat = 0;

    const phrase = [
      { freq: HZ.G5, at: 0.00, dur: 0.13 },
      { freq: HZ.E5, at: 0.13, dur: 0.13 },
      { freq: HZ.C5, at: 0.26, dur: 0.13 },
      { freq: HZ.G4, at: 0.39, dur: 0.46 },
    ];
    for (const step of phrase) {
      note(c, { ...step, type: 'sawtooth', gain: 0.16, cutoff: 2400 });
      // A quiet octave below thickens each step without muddying it.
      note(c, { ...step, freq: step.freq / 2, type: 'triangle', gain: 0.09, cutoff: 1400 });
    }
    // The floor drops out underneath the last note.
    note(c, {
      freq: HZ.C4, glideTo: HZ.C3, at: 0.39, dur: 0.7,
      type: 'sine', gain: 0.26, cutoff: 700,
    });
  }

  // --- leaderboard ------------------------------------------------------------

  /**
   * One pair of hands: a very short burst of band-passed noise. The near-
   * instant attack and the fast decay are the whole character of a clap, and
   * the band-pass centre is what makes one pair of hands sound unlike another
   * — cupped hands are low and hollow, flat palms high and sharp.
   */
  function buildClap(sampleRate, centre, q, seconds) {
    const length = Math.ceil(sampleRate * seconds);
    const out = new Float32Array(length);

    // Two-pole band-pass, run by hand over the noise so it can be baked into
    // the buffer. Same coefficients a BiquadFilterNode would use.
    const w = (2 * Math.PI * centre) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const norm = 1 + alpha;
    const b0 = alpha / norm;
    const a1 = (-2 * Math.cos(w)) / norm;
    const a2 = (1 - alpha) / norm;

    // Run the filter twice. One pass leaves enough white sizzle either side of
    // the centre to read as a noise tick; two passes give the steeper skirts
    // that make it read as a pitched slap.
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let u1 = 0;
    let u2 = 0;
    let v1 = 0;
    let v2 = 0;
    let peak = 0;

    for (let i = 0; i < length; i += 1) {
      const envelope = Math.min(1, i / 14) * Math.exp((-i / length) * 7.5);
      const x0 = (Math.random() * 2 - 1) * envelope;
      // b1 is zero for a band-pass, and b2 is -b0, hence the missing terms.
      const y0 = b0 * (x0 - x2) - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;

      const v0 = b0 * (y0 - u2) - a1 * v1 - a2 * v2;
      u2 = u1;
      u1 = y0;
      v2 = v1;
      v1 = v0;

      out[i] = v0;
      if (Math.abs(v0) > peak) peak = Math.abs(v0);
    }

    if (peak > 0) for (let i = 0; i < length; i += 1) out[i] /= peak;
    return out;
  }

  /**
   * Applause, built once and cached.
   *
   * The room is modelled as forty-odd individual clappers rather than as
   * noise: each one gets a single burst of its own and repeats *that same
   * burst* at its own irregular rate, from its own place in the room. Reusing
   * one burst per person is what makes it read as hands — drawing fresh random
   * noise for every clap averages out into static, which is what the earlier
   * version did. There is no continuous hiss behind them for the same reason;
   * the only bed is a whisper of room tone to stop it sounding anechoic.
   */
  function buildApplause(c) {
    const rate = c.sampleRate;
    const seconds = 3.4;
    const length = Math.floor(rate * seconds);
    const buffer = c.createBuffer(2, length, rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const CLAPPERS = 42;
    for (let n = 0; n < CLAPPERS; n += 1) {
      const clap = buildClap(
        rate,
        780 + Math.random() * 1850,      // hollow to sharp
        0.9 + Math.random() * 2.1,
        0.022 + Math.random() * 0.028,
      );

      // Most of the room is further away than the front row, so bias quiet.
      const level = 0.22 + (Math.random() ** 1.7) * 0.78;
      const pan = Math.random();
      const gainL = level * Math.sqrt(1 - pan);
      const gainR = level * Math.sqrt(pan);

      const period = rate * (0.23 + Math.random() * 0.21);   // 2.3–4.3 per sec
      // Nobody starts on the same beat, and the room joins in over a moment
      // rather than all at once.
      let at = Math.random() * 0.3 * rate;

      while (at < length) {
        const start = Math.floor(at);
        const limit = Math.min(clap.length, length - start);
        for (let i = 0; i < limit; i += 1) {
          const value = clap[i];
          left[start + i] += value * gainL;
          right[start + i] += value * gainR;
        }
        at += period * (0.85 + Math.random() * 0.3);         // not a metronome
      }
    }

    // Room tone: barely there, just enough to glue the claps together.
    let bedL = 0;
    let bedR = 0;
    for (let i = 0; i < length; i += 1) {
      bedL = bedL * 0.988 + (Math.random() * 2 - 1) * 0.012;
      bedR = bedR * 0.988 + (Math.random() * 2 - 1) * 0.012;
      left[i] += bedL * 0.5;
      right[i] += bedR * 0.5;
    }

    // Let the room die down instead of being cut off mid-clap.
    const fadeFrom = Math.floor(length * 0.6);
    let peak = 0;
    for (let i = 0; i < length; i += 1) {
      if (i >= fadeFrom) {
        const t = (i - fadeFrom) / (length - fadeFrom);
        const g = (1 - t) ** 1.7;
        left[i] *= g;
        right[i] *= g;
      }
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }
    if (peak > 0) {
      const scale = 0.9 / peak;
      for (let i = 0; i < length; i += 1) {
        left[i] *= scale;
        right[i] *= scale;
      }
    }
    return buffer;
  }

  /** Rising major arpeggio, played over the front of the applause. */
  function fanfare(c) {
    [
      { freq: HZ.C5, at: 0.00 },
      { freq: HZ.E5, at: 0.09 },
      { freq: HZ.G5, at: 0.18 },
      { freq: HZ.C6, at: 0.27, dur: 0.5 },
    ].forEach(({ freq, at, dur = 0.22 }) => {
      note(c, { freq, at, dur, type: 'triangle', gain: 0.19, cutoff: 6000 });
      note(c, { freq: freq * 2, at, dur: dur * 0.6, type: 'sine', gain: 0.07 });
    });
  }

  function applause() {
    const c = ready();
    if (!c) return;
    if (!applauseBuf) applauseBuf = buildApplause(c);

    fanfare(c);

    const source = c.createBufferSource();
    source.buffer = applauseBuf;

    // Only rumble needs trimming; the claps are already band-limited, and the
    // low-pass this used to carry was most of what made them sound like hiss.
    const highPass = c.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 220;

    const gain = c.createGain();
    gain.gain.value = 0.62;

    source.connect(highPass).connect(gain).connect(master);
    source.start(c.currentTime);
  }

  // --- mute -------------------------------------------------------------------

  function isMuted() {
    return muted;
  }

  function setMuted(value) {
    muted = Boolean(value);
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      /* storage disabled; the setting lasts for this page only */
    }
    if (muted && ctx) ctx.suspend().catch(() => {});
    else if (!muted) ready();
    return muted;
  }

  function toggle() {
    return setMuted(!muted);
  }

  return { tick, timeUp, applause, isMuted, setMuted, toggle, unlock };
})();
