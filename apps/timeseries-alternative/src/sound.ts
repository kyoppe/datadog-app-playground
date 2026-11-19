// Tiny synthesised sounds for the chart (no samples): a blip when the pointer moves onto a
// building and a soft chime when new data arrives. Pentatonic, so it never sounds wrong.

export type Sound = {
    /** Must be called from a user gesture the first time (autoplay rules). */
    resume(): void;
    /** ratio 0..1 -> pitch. */
    tick(ratio: number): void;
    chime(ratio: number): void;
    /** The clatter of blocks piling up (rising) or being scattered (falling). */
    clatter(rising: boolean): void;
    dispose(): void;
};

const SCALE = [0, 2, 4, 7, 9];

function frequency(ratio: number) {
    const step = Math.round(Math.min(Math.max(ratio, 0), 1) * 9);
    const semitones = SCALE[step % SCALE.length] + 12 * Math.floor(step / SCALE.length);
    return 261.63 * Math.pow(2, semitones / 12);
}

export function createSound(): Sound {
    let context: AudioContext | null = null;

    const ensure = () => {
        if (context) {
            return context;
        }
        const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
            return null;
        }
        context = new Ctor();
        return context;
    };

    const blip = (hz: number, type: OscillatorType, peak: number, seconds: number, delay = 0) => {
        const audio = ensure();
        if (!audio || audio.state !== 'running') {
            return;
        }
        const start = audio.currentTime + delay;
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = type;
        oscillator.frequency.value = hz;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(start);
        oscillator.stop(start + seconds + 0.05);
    };

    // A short click of noise, like one block landing on another, and a dull knock under it.
    let noise: AudioBuffer | null = null;
    const click = (delay: number, hz: number, loudness: number) => {
        const audio = ensure();
        if (!audio || audio.state !== 'running') {
            return;
        }
        if (!noise) {
            noise = audio.createBuffer(1, Math.floor(audio.sampleRate * 0.2), audio.sampleRate);
            const samples = noise.getChannelData(0);
            for (let index = 0; index < samples.length; index += 1) {
                samples[index] = Math.random() * 2 - 1;
            }
        }
        const start = audio.currentTime + delay;

        const source = audio.createBufferSource();
        source.buffer = noise;
        const band = audio.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = hz * 5;
        band.Q.value = 1.6;
        const gain = audio.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16 * loudness, start + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.07);
        source.connect(band).connect(gain).connect(audio.destination);
        source.start(start, Math.random() * 0.1);
        source.stop(start + 0.09);

        const knock = audio.createOscillator();
        const knockGain = audio.createGain();
        knock.type = 'sine';
        knock.frequency.setValueAtTime(hz, start);
        knock.frequency.exponentialRampToValueAtTime(hz * 0.55, start + 0.07);
        knockGain.gain.setValueAtTime(0.0001, start);
        knockGain.gain.exponentialRampToValueAtTime(0.1 * loudness, start + 0.004);
        knockGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
        knock.connect(knockGain).connect(audio.destination);
        knock.start(start);
        knock.stop(start + 0.11);
    };

    return {
        resume() {
            const audio = ensure();
            if (audio && audio.state === 'suspended') {
                void audio.resume();
            }
        },
        tick(ratio) {
            blip(frequency(ratio), 'sine', 0.05, 0.09);
        },
        chime(ratio) {
            const hz = frequency(ratio);
            blip(hz, 'triangle', 0.06, 0.9);
            blip(hz * 1.5, 'triangle', 0.035, 0.9, 0.09);
        },
        clatter(rising) {
            // a dozen clicks over about half a second, a little uneven, climbing or falling
            const clicks = 12;
            for (let index = 0; index < clicks; index += 1) {
                const t = index / (clicks - 1);
                const pitch = 150 + 170 * (rising ? t : 1 - t) + Math.random() * 40;
                const when = t * 0.42 + Math.random() * 0.03;
                click(when, pitch, 0.55 + 0.45 * Math.random());
            }
        },
        dispose() {
            void context?.close();
            context = null;
        },
    };
}
