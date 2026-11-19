import { useState, type ChangeEvent, type PointerEvent } from 'react';

type Ripple = {
    id: number;
    x: number;
    y: number;
};

const demos = [
    {
        title: 'Ripple text',
        description: 'Every keystroke makes a small wave.',
    },
    {
        title: 'Deep links',
        description: 'A stateful view that can be shared.',
    },
    {
        title: 'Datadog ready',
        description: 'A frontend shell ready for data.',
    },
];

function App() {
    const [text, setText] = useState('Hello from Datadog');
    const [ripples, setRipples] = useState<Ripple[]>([]);
    const [activeDemo, setActiveDemo] = useState(0);

    const spawnRipple = (x: number, y: number) => {
        const ripple = {
            id: Date.now() + Math.random(),
            x,
            y,
        };
        setRipples((current) => [...current.slice(-8), ripple]);
    };

    const handleWaterPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = ((event.clientX - bounds.left) / bounds.width) * 100;
        const y = ((event.clientY - bounds.top) / bounds.height) * 100;
        spawnRipple(x, y);
    };

    const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
        setText(event.target.value);
        spawnRipple(25 + Math.random() * 50, 35 + Math.random() * 30);
    };

    const removeRipple = (id: number) => {
        setRipples((current) => current.filter((ripple) => ripple.id !== id));
    };

    const reset = () => {
        setText('');
        setRipples([]);
    };

    return (
        <>
            <style>{`
                :root {
                    color-scheme: dark;
                }

                * {
                    box-sizing: border-box;
                }

                body {
                    margin: 0;
                    background: #101548;
                }

                button,
                input {
                    font: inherit;
                }

                .playground {
                    min-height: 100vh;
                    padding: 48px 24px 56px;
                    color: #f8fbff;
                    background:
                        radial-gradient(circle at 20% 0%, rgba(65, 89, 220, 0.4), transparent 34%),
                        linear-gradient(145deg, #101548 0%, #171e5d 52%, #0c123d 100%);
                    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                }

                .shell {
                    width: min(980px, 100%);
                    margin: 0 auto;
                }

                .eyebrow {
                    margin: 0 0 12px;
                    color: #93a7ff;
                    font-size: 12px;
                    font-weight: 700;
                    letter-spacing: 0.16em;
                    text-transform: uppercase;
                }

                h1 {
                    max-width: 720px;
                    margin: 0;
                    font-size: clamp(42px, 7vw, 78px);
                    line-height: 0.98;
                    letter-spacing: -0.065em;
                }

                .intro {
                    max-width: 620px;
                    margin: 22px 0 34px;
                    color: #c1c9ee;
                    font-size: 17px;
                    line-height: 1.6;
                }

                .water-demo {
                    position: relative;
                    min-height: 360px;
                    overflow: hidden;
                    border: 1px solid rgba(190, 230, 255, 0.45);
                    border-radius: 22px;
                    padding: 42px;
                    background:
                        linear-gradient(150deg, rgba(47, 206, 255, 0.75), rgba(22, 103, 201, 0.88)),
                        repeating-linear-gradient(12deg, rgba(255, 255, 255, 0.12) 0 2px, transparent 2px 15px);
                    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.3), inset 0 1px rgba(255, 255, 255, 0.32);
                    cursor: crosshair;
                    isolation: isolate;
                }

                .water-demo::before,
                .water-demo::after {
                    position: absolute;
                    inset: -30%;
                    z-index: -1;
                    border-radius: 42%;
                    background: rgba(255, 255, 255, 0.12);
                    content: "";
                    transform: rotate(-7deg);
                    animation: drift 12s ease-in-out infinite alternate;
                }

                .water-demo::after {
                    animation-delay: -5s;
                    opacity: 0.45;
                    transform: rotate(9deg) translate(8%, -4%);
                }

                .water-title {
                    max-width: 560px;
                    margin: 0 0 18px;
                    font-size: clamp(34px, 6vw, 66px);
                    line-height: 0.98;
                    letter-spacing: -0.06em;
                    text-shadow: 0 3px 0 rgba(0, 41, 105, 0.28);
                }

                .water-copy {
                    max-width: 520px;
                    margin: 0 0 28px;
                    color: rgba(238, 252, 255, 0.9);
                    line-height: 1.5;
                }

                .input-wrap {
                    position: relative;
                    max-width: 620px;
                }

                .water-input {
                    width: 100%;
                    border: 3px solid #f9de57;
                    border-radius: 14px;
                    padding: 14px 18px;
                    color: #0b286e;
                    background: rgba(255, 255, 255, 0.92);
                    outline: none;
                    box-shadow: 0 8px 0 rgba(0, 39, 117, 0.16);
                    font-size: 20px;
                    font-weight: 700;
                }

                .water-input:focus {
                    border-color: #fff7ad;
                    box-shadow: 0 0 0 4px rgba(255, 247, 173, 0.25), 0 8px 0 rgba(0, 39, 117, 0.16);
                }

                .underwater-text {
                    position: absolute;
                    right: 42px;
                    bottom: 28px;
                    left: 42px;
                    overflow: hidden;
                    color: rgba(224, 249, 255, 0.75);
                    font-size: clamp(20px, 4vw, 42px);
                    font-weight: 800;
                    letter-spacing: -0.04em;
                    text-align: center;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .ripple {
                    position: absolute;
                    width: 18px;
                    height: 18px;
                    border: 2px solid rgba(255, 255, 255, 0.84);
                    border-radius: 50%;
                    pointer-events: none;
                    animation: ripple 1.6s ease-out forwards;
                }

                .controls {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 16px;
                    margin-top: 24px;
                }

                .status {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    color: #aeb9ec;
                    font-size: 13px;
                }

                .pill {
                    border: 1px solid rgba(177, 191, 255, 0.3);
                    border-radius: 999px;
                    padding: 7px 11px;
                    background: rgba(255, 255, 255, 0.08);
                }

                .reset {
                    border: 1px solid rgba(255, 255, 255, 0.45);
                    border-radius: 999px;
                    padding: 9px 15px;
                    color: #f8fbff;
                    background: rgba(255, 255, 255, 0.1);
                    cursor: pointer;
                }

                .reset:hover {
                    background: rgba(255, 255, 255, 0.18);
                }

                .section-label {
                    margin: 58px 0 16px;
                    color: #93a7ff;
                    font-size: 12px;
                    font-weight: 700;
                    letter-spacing: 0.16em;
                    text-transform: uppercase;
                }

                .cards {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 14px;
                }

                .demo-card {
                    min-height: 142px;
                    border: 1px solid rgba(180, 193, 255, 0.24);
                    border-radius: 16px;
                    padding: 20px;
                    color: #f8fbff;
                    background: rgba(255, 255, 255, 0.07);
                    text-align: left;
                    cursor: pointer;
                    transition: transform 160ms ease, background 160ms ease, border-color 160ms ease;
                }

                .demo-card:hover,
                .demo-card.active {
                    border-color: rgba(158, 219, 255, 0.8);
                    background: rgba(99, 157, 255, 0.2);
                    transform: translateY(-3px);
                }

                .demo-card strong {
                    display: block;
                    margin-bottom: 10px;
                    font-size: 16px;
                }

                .demo-card span {
                    color: #b5c0ec;
                    font-size: 14px;
                    line-height: 1.45;
                }

                @keyframes ripple {
                    to {
                        width: 260px;
                        height: 260px;
                        margin: -121px;
                        opacity: 0;
                    }
                }

                @keyframes drift {
                    to {
                        transform: rotate(8deg) translate(5%, 8%);
                    }
                }

                @media (max-width: 700px) {
                    .playground {
                        padding: 28px 16px 40px;
                    }

                    .water-demo {
                        min-height: 420px;
                        padding: 26px;
                    }

                    .underwater-text {
                        right: 26px;
                        bottom: 24px;
                        left: 26px;
                    }

                    .controls {
                        align-items: flex-start;
                        flex-direction: column;
                    }

                    .cards {
                        grid-template-columns: 1fr;
                    }
                }
            `}</style>
            <main className="playground">
                <div className="shell">
                    <p className="eyebrow">Datadog Apps Playground</p>
                    <h1>HTML-in-Canvas is now in Datadog Apps</h1>
                    <p className="intro">
                        A tiny frontend-only experiment inspired by the shared Claude Artifact.
                        Type, click, and watch the water respond. No Datadog API or upload is
                        needed for this first test.
                    </p>

                    <section
                        className="water-demo"
                        aria-label="Interactive underwater text demo"
                        onPointerDown={handleWaterPointerDown}
                    >
                        {ripples.map((ripple) => (
                            <span
                                className="ripple"
                                key={ripple.id}
                                onAnimationEnd={() => removeRipple(ripple.id)}
                                style={{
                                    left: `${ripple.x}%`,
                                    top: `${ripple.y}%`,
                                }}
                            />
                        ))}
                        <h2 className="water-title">You can type underwater</h2>
                        <p className="water-copy">
                            Click anywhere in the pool or type in the field. Each interaction
                            creates a ripple using ordinary React state and CSS animation.
                        </p>
                        <div className="input-wrap">
                            <input
                                className="water-input"
                                aria-label="Type underwater"
                                value={text}
                                onChange={handleInput}
                                placeholder="Type something..."
                            />
                        </div>
                        <div className="underwater-text">{text || 'The water is waiting...'}</div>
                    </section>

                    <div className="controls">
                        <div className="status">
                            <span className="pill">Frontend only</span>
                            <span className="pill">React + TypeScript</span>
                            <span className="pill">No upload</span>
                        </div>
                        <button className="reset" type="button" onClick={reset}>
                            Reset demo
                        </button>
                    </div>

                    <p className="section-label">What this proves</p>
                    <div className="cards">
                        {demos.map((demo, index) => (
                            <button
                                className={`demo-card ${activeDemo === index ? 'active' : ''}`}
                                key={demo.title}
                                type="button"
                                onClick={() => setActiveDemo(index)}
                            >
                                <strong>{demo.title}</strong>
                                <span>{demo.description}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </main>
        </>
    );
}

export default App;
