import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { bannerSrc } from './terminalBanner';

type TerminalLine = {
    id: number;
    text: string;
    className: string;
    typing: boolean;
};

const CANCELLED = Symbol('cancelled');

const miniAppRows = [
    { name: 'Active incidents', pill: '3 open', tone: 'wait' },
    { name: 'Mean time to resolve', pill: '96 min', tone: 'ok' },
    { name: 'Customers impacted', pill: '17', tone: 'wait' },
] as const;

// The CLI "recording": plain HTML that types itself out, so it can live inside the canvas
// and be warped by the shader like everything else.
function TerminalDemo() {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [lines, setLines] = useState<TerminalLine[]>([]);
    const [bannerShown, setBannerShown] = useState(false);
    const [appShown, setAppShown] = useState(false);
    const [fading, setFading] = useState(false);

    // Keep the newest line in view by sliding the whole log up.
    useLayoutEffect(() => {
        const scroll = scrollRef.current;
        const body = scroll?.parentElement;
        if (!scroll || !body) {
            return;
        }

        const distance = scroll.scrollHeight - body.clientHeight + 30;
        // After a loop reset the log is invisible: jump back instead of sliding.
        scroll.style.transition = lines.length === 0 ? 'opacity 0.48s ease' : '';
        scroll.style.transform = distance > 0 ? `translateY(${-distance}px)` : 'translateY(0)';
    }, [lines]);

    useEffect(() => {
        let cancelled = false;
        let nextId = 0;

        const wait = (milliseconds: number) =>
            new Promise<void>((resolve, reject) => {
                window.setTimeout(() => (cancelled ? reject(CANCELLED) : resolve()), milliseconds);
            });

        const addLine = (text: string) => {
            const id = (nextId += 1);
            setLines((current) => [...current, { id, text, className: '', typing: false }]);
        };

        const typeLine = async (text: string, className: string, speed: number) => {
            const id = (nextId += 1);
            const characters = Array.from(text);
            setLines((current) => [...current, { id, text: '', className, typing: true }]);

            for (let count = 1; count <= characters.length; count += 1) {
                await wait(speed);
                const typed = characters.slice(0, count).join('');
                setLines((current) =>
                    current.map((line) => (line.id === id ? { ...line, text: typed } : line)),
                );
            }

            setLines((current) =>
                current.map((line) => (line.id === id ? { ...line, typing: false } : line)),
            );
        };

        const run = async () => {
            for (;;) {
                setLines([]);
                setAppShown(false);
                setBannerShown(false);
                setFading(false);
                await wait(60);
                setBannerShown(true);
                await wait(1100);

                await typeLine(
                    '$ npx skills add datadog-labs/agent-skills --skill datadog-app',
                    't-white',
                    18,
                );
                await wait(450);
                addLine('› adding skill from datadog-labs/agent-skills…');
                await wait(420);
                addLine('✔ Installed skill datadog-app');
                await wait(300);
                addLine('# restart your agent, then just describe the app');
                await wait(620);

                await typeLine(
                    '▌ Build an exec view of incident MTTR joined with GitHub, Jira and Confluence.',
                    't-violet',
                    20,
                );
                await wait(520);
                addLine('✶ working with the datadog-app skill…');
                await wait(560);

                await typeLine(
                    '▸ $ npm create @datadog/apps@latest -- --name dev-insights',
                    't-white',
                    13,
                );
                await wait(340);
                addLine('+ src/App.tsx');
                await wait(190);
                addLine('+ src/insights.backend.ts  # server-side, holds the token');
                await wait(190);
                addLine('+ app.json');
                await wait(380);

                await typeLine('▸ $ npm run dev', 't-white', 16);
                await wait(300);
                addLine('➜ local preview  localhost:3000 ready in 412ms');
                await wait(380);

                await typeLine('▸ $ npm run upload', 't-white', 16);
                await wait(360);
                addLine('bundling… uploading… done');
                await wait(900);

                await typeLine('✓ Live · app.datadoghq.com/apps/dev-insights', 't-white', 16);
                await wait(740);
                setAppShown(true);
                await wait(2600);
                setFading(true);
                await wait(480);
            }
        };

        run().catch((error: unknown) => {
            if (error !== CANCELLED) {
                console.error(error);
            }
        });

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="term-body">
            <div className="term-scroll" ref={scrollRef} style={{ opacity: fading ? 0 : 1 }}>
                <img
                    className={`term-banner${bannerShown ? ' show' : ''}`}
                    src={bannerSrc}
                    alt="Datadog Apps CLI"
                />
                {lines.map((line) => (
                    <div className="term-line" key={line.id}>
                        <span className={line.className}>{line.text}</span>
                        {line.typing && <span className="term-cursor" />}
                    </div>
                ))}
            </div>
            <div className={`mini-app${appShown ? ' show' : ''}`}>
                <div className="mini-browser">
                    <span className="mini-url">app.datadoghq.com/apps/dev-insights</span>
                </div>
                <div className="mini-head">
                    <span className="mini-title">Development Insights</span>
                    <span className="mini-badge">
                        <span className="mini-live" />
                        APP LIVE
                    </span>
                </div>
                {miniAppRows.map((row) => (
                    <div className="mini-row" key={row.name}>
                        <span className="mini-name">{row.name}</span>
                        <span className={`mini-pill ${row.tone}`}>{row.pill}</span>
                        <span className={`mini-dot ${row.tone}`} />
                    </div>
                ))}
            </div>
        </div>
    );
}

export default TerminalDemo;
