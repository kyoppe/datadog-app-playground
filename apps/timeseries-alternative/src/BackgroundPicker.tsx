import { useEffect, useRef, useState } from 'react';
import { PRESETS, TRANSPARENT } from './colors';

// The colour behind the chart, picked from a few good ones or from a colour wheel (hue round it,
// saturation outwards, brightness on the slider). The code of the colour is shown to copy into
// the widget's settings.

const WHEEL = 150;

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const f = (n: number) => {
        const k = (n + h / 60) % 6;
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
}

function toHex([r, g, b]: [number, number, number]) {
    const part = (x: number) =>
        Math.round(Math.max(0, Math.min(1, x)) * 255)
            .toString(16)
            .padStart(2, '0');
    return `#${part(r)}${part(g)}${part(b)}`;
}

type Props = { value: string; onPick: (hex: string) => void };

export function BackgroundPicker({ value, onPick }: Props) {
    const [open, setOpen] = useState(false);
    const [brightness, setBrightness] = useState(0.7);
    const wheel = useRef<HTMLCanvasElement>(null);

    // the wheel at the chosen brightness
    useEffect(() => {
        const canvas = wheel.current;
        const context = open ? canvas?.getContext('2d') : null;
        if (!canvas || !context) {
            return;
        }
        const image = context.createImageData(WHEEL, WHEEL);
        const radius = WHEEL / 2;
        for (let y = 0; y < WHEEL; y += 1) {
            for (let x = 0; x < WHEEL; x += 1) {
                const dx = x + 0.5 - radius;
                const dy = y + 0.5 - radius;
                const distance = Math.hypot(dx, dy) / radius;
                const at = (y * WHEEL + x) * 4;
                if (distance <= 1) {
                    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
                    const [r, g, b] = hsvToRgb(hue, distance, brightness);
                    image.data[at] = r * 255;
                    image.data[at + 1] = g * 255;
                    image.data[at + 2] = b * 255;
                    image.data[at + 3] = 255;
                }
            }
        }
        context.putImageData(image, 0, 0);
    }, [open, brightness]);

    const pickFromWheel = (clientX: number, clientY: number) => {
        const rect = wheel.current?.getBoundingClientRect();
        if (!rect) {
            return;
        }
        const dx = ((clientX - rect.left) / rect.width) * 2 - 1;
        const dy = ((clientY - rect.top) / rect.height) * 2 - 1;
        const distance = Math.min(1, Math.hypot(dx, dy));
        const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        onPick(toHex(hsvToRgb(hue, distance, brightness)));
    };

    return (
        <>
            <button
                type="button"
                className={open ? 'on' : ''}
                title="The background behind the chart: a colour, or transparent"
                onClick={() => setOpen(!open)}
            >
                Background
            </button>
            {open && (
                <div className="picker" role="dialog" aria-label="Background colour">
                    <div className="picker-swatches">
                        {PRESETS.map((preset) => (
                            <button
                                key={preset.name}
                                type="button"
                                className={`swatch-button${preset.color === value ? ' on' : ''}`}
                                title={preset.name}
                                aria-label={preset.name}
                                style={
                                    preset.color === TRANSPARENT
                                        ? {
                                              background:
                                                  'repeating-conic-gradient(#8a8a96 0 25%, #d8d8e0 0 50%) 0 0 / 10px 10px',
                                          }
                                        : preset.color
                                          ? { backgroundColor: preset.color }
                                          : {
                                                background:
                                                    'linear-gradient(135deg, #807b78 50%, #1c1a30 50%)',
                                            }
                                }
                                onClick={() => onPick(preset.color)}
                            />
                        ))}
                    </div>
                    <canvas
                        ref={wheel}
                        className="picker-wheel"
                        width={WHEEL}
                        height={WHEEL}
                        aria-label="Colour wheel"
                        onPointerDown={(event) => {
                            event.currentTarget.setPointerCapture(event.pointerId);
                            pickFromWheel(event.clientX, event.clientY);
                        }}
                        onPointerMove={(event) => {
                            if (event.buttons === 1) {
                                pickFromWheel(event.clientX, event.clientY);
                            }
                        }}
                    />
                    <label className="picker-brightness">
                        Brightness
                        <input
                            type="range"
                            min={0.15}
                            max={1}
                            step={0.01}
                            value={brightness}
                            onChange={(event) => setBrightness(Number(event.target.value))}
                        />
                    </label>
                    <div className="picker-code">
                        <input
                            readOnly
                            aria-label="Colour code, to copy into Edit Graph"
                            value={value || 'default'}
                            size={9}
                            onClick={(event) => event.currentTarget.select()}
                            onFocus={(event) => event.currentTarget.select()}
                        />
                        <span>copy it into &quot;Background&quot; in Edit Graph</span>
                    </div>
                </div>
            )}
        </>
    );
}
