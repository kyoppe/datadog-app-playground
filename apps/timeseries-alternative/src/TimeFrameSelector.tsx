import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { parseTimeFrame, shortOf, suggestFrames, type TimeFrame } from './timeFrame';

// Datadog's time frame control: a box with the short form of the frame (1h) and its name, and
// three buttons beside it: step back one window, pause / resume the live tail, step forward.
// Open, the box takes typed frames (5m, 1 week, since Jan 1, yesterday, ...) with a completion
// list that follows what is typed.

type TimeFrameSelectorProps = {
    frame: TimeFrame;
    /** The window follows the clock. */
    live: boolean;
    onApply: (frame: TimeFrame) => void;
    onStep: (direction: -1 | 1) => void;
    onToggleLive: () => void;
};

function Icon({ children }: { children: ReactNode }) {
    return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            {children}
        </svg>
    );
}

export function TimeFrameSelector({
    frame,
    live,
    onApply,
    onStep,
    onToggleLive,
}: TimeFrameSelectorProps) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [active, setActive] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const suggestions = open ? suggestFrames(text) : [];
    const badge = frame.kind === 'sliding' ? shortOf(frame.seconds) : null;

    const close = () => {
        setOpen(false);
        setText('');
        setActive(0);
        setError(null);
    };

    const apply = (value: string) => {
        const result = parseTimeFrame(value, Date.now());
        if ('error' in result) {
            setError(result.error);
            return;
        }
        onApply(result.frame);
        close();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((current) => Math.min(current + 1, Math.max(suggestions.length - 1, 0)));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((current) => Math.max(current - 1, 0));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            // The highlighted suggestion wins; free text such as "Jan 1 - Jan 5" has none.
            apply(suggestions[active]?.text ?? text);
        } else if (event.key === 'Escape') {
            close();
        }
    };

    return (
        <div className="tf-row">
            <div
                className="tf"
                onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                        close();
                    }
                }}
            >
                <button
                    type="button"
                    className="tf-button"
                    aria-expanded={open}
                    onClick={() => (open ? close() : setOpen(true))}
                >
                    {badge && <span className="tf-badge">{badge}</span>}
                    <span className="tf-label">{frame.label}</span>
                </button>
                {open && (
                    <div className="tf-panel">
                        <input
                            autoFocus
                            aria-label="Time frame"
                            spellCheck={false}
                            placeholder="5m, 1 week, since Jan 1, yesterday..."
                            value={text}
                            onChange={(event) => {
                                setText(event.target.value);
                                setActive(0);
                                setError(null);
                            }}
                            onKeyDown={onKeyDown}
                        />
                        {error && <p className="tf-error">{error}</p>}
                        <ul role="listbox">
                            {suggestions.map((suggestion, index) => (
                                <li
                                    key={suggestion.text}
                                    role="option"
                                    aria-selected={index === active}
                                    className={index === active ? 'active' : ''}
                                    // mousedown, not click: the box must not lose focus first.
                                    onMouseDown={(event) => {
                                        event.preventDefault();
                                        apply(suggestion.text);
                                    }}
                                    onMouseEnter={() => setActive(index)}
                                >
                                    {suggestion.label}
                                </li>
                            ))}
                            {suggestions.length === 0 && text.trim() !== '' && (
                                <li className="note">Press Enter to apply {text.trim()}</li>
                            )}
                        </ul>
                    </div>
                )}
            </div>
            <div className="tf-steps">
                <button
                    type="button"
                    aria-label="Back one window"
                    title="Back one window"
                    onClick={() => onStep(-1)}
                >
                    <Icon>
                        <path d="M8.5 3.5v9L2.5 8zM14 3.5v9L8 8z" />
                    </Icon>
                </button>
                <button
                    type="button"
                    className={live ? 'on' : ''}
                    aria-pressed={live}
                    aria-label={live ? 'Pause' : 'Resume live'}
                    title={live ? 'Pause' : 'Resume live'}
                    onClick={onToggleLive}
                >
                    <Icon>
                        {live ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="M5 3l8 5-8 5z" />}
                    </Icon>
                </button>
                <button
                    type="button"
                    aria-label="Forward one window"
                    title="Forward one window"
                    disabled={live}
                    onClick={() => onStep(1)}
                >
                    <Icon>
                        <path d="M7.5 3.5v9L13.5 8zM2 3.5v9L8 8z" />
                    </Icon>
                </button>
            </div>
        </div>
    );
}
