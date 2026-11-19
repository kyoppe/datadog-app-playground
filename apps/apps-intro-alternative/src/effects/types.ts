// Contract between the host (HtmlCanvasArticle) and the interchangeable WebGL effects.
//
// The host owns the <canvas>, one WebGL2 context, the HTML-in-Canvas paint loop and the
// page texture. An effect only turns that page texture (plus pointer input) into pixels.

export type PointerState = {
    /** CSS px, origin at the canvas top-left. */
    x: number;
    y: number;
    /** CSS px per second, smoothed. */
    vx: number;
    vy: number;
    /** Primary button / touch is down. */
    down: boolean;
    /** Pointer is currently over the stage. */
    inside: boolean;
};

export type PointerEventKind = 'down' | 'move' | 'up' | 'leave';

export type EffectFrame = {
    /** Seconds since the host started. */
    time: number;
    /** Seconds since the previous render, clamped to [0, 0.05]. */
    dt: number;
    /** Canvas size in CSS px. The drawing buffer is round(width * dpr) x round(height * dpr). */
    width: number;
    height: number;
    dpr: number;
    /**
     * The live page, uploaded by the host this frame. TEXTURE_2D, RGBA8, opaque, LINEAR
     * filtering, CLAMP_TO_EDGE. Texture coordinate v = 0 is the TOP of the page and v = 1 the
     * bottom (no UNPACK_FLIP_Y). The texture covers the whole canvas.
     */
    pageTexture: WebGLTexture;
    /** Size of pageTexture in texels. */
    pageSize: { width: number; height: number };
    pointer: PointerState;
};

export interface Effect {
    readonly name: string;
    /**
     * Called before the first render and whenever the canvas size changes. Reallocate any
     * size-dependent render targets here. The host has already resized the drawing buffer.
     */
    resize(width: number, height: number, dpr: number): void;
    /** Optional: put the effect back in its starting state (the host's Reset button). */
    reset?(): void;
    /** Optional: text for the host's reset button when it does not mean "Reset". */
    readonly resetLabel?: string;
    /**
     * Optional: false while the effect draws the page somewhere other than where it was laid
     * out (or smears it), so links are not left clickable at their old place.
     */
    pageInteractive?(): boolean;
    /** Optional discrete pointer events, in addition to `frame.pointer`. */
    pointerEvent?(kind: PointerEventKind, pointer: PointerState): void;
    /**
     * Draw one frame to the default framebuffer. On return the effect must leave: framebuffer
     * null bound, viewport (0, 0, canvas.width, canvas.height), BLEND / DEPTH_TEST /
     * STENCIL_TEST / SCISSOR_TEST / CULL_FACE disabled, no VAO bound, ACTIVE_TEXTURE = TEXTURE0.
     */
    render(frame: EffectFrame): void;
    /** Delete every GL object the effect created. */
    dispose(): void;
}

/** May throw an Error (with a readable message) if the GPU lacks something the effect needs. */
export type EffectFactory = (gl: WebGL2RenderingContext) => Effect;
