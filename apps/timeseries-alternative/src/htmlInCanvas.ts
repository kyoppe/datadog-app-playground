// HTML-in-Canvas is not part of lib.dom yet, so describe only the surface used here.
export type HtmlInCanvasElement = HTMLCanvasElement & {
    requestPaint(): void;
    getElementImageDefaultSize(element: Element): { width: number; height: number };
};

export type HtmlInCanvasContext = WebGL2RenderingContext & {
    texElementSubImage2D(
        target: number,
        level: number,
        xoffset: number,
        yoffset: number,
        element: Element,
    ): void;
};

// Decided by probing for the feature itself, never by browser name or version.
export function supportsHtmlInCanvas() {
    if (typeof document === 'undefined' || typeof WebGL2RenderingContext === 'undefined') {
        return false;
    }

    const probe = document.createElement('canvas');
    probe.setAttribute('content', 'drawable');

    return (
        (probe as { content?: string }).content === 'drawable' &&
        'requestPaint' in probe &&
        'texElementSubImage2D' in WebGL2RenderingContext.prototype
    );
}
