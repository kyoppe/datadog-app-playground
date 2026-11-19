// Contract between the host (TimeseriesAlternative) and the WebGL bar renderer.
//
// The host owns the <canvas content="drawable">, one WebGL2 context, the HTML-in-Canvas paint
// loop and the page texture. The page is a real HTML table (a spreadsheet of metric values: one
// row per series, one column per time bucket). The renderer lays that page out as the ground of
// a small board and stands one box on every cell, as tall as the cell's value (a 3D bar chart).

export type BarRect = { x: number; y: number; w: number; h: number };

export type BarScene = {
    /** Size of the page (the table) in CSS px. The ground plane has this aspect ratio. */
    pageWidth: number;
    pageHeight: number;
    cols: number;
    rows: number;
    /** Rect of every table cell inside the page, CSS px, row-major, length rows * cols. */
    cells: ReadonlyArray<BarRect>;
    /** Value of every cell, row-major, length rows * cols. NaN means no data: no building. */
    values: ReadonlyArray<number>;
    /** The value that maps to a full-height building. Always > 0. */
    max: number;
    /** One linear-ish RGB colour (0..1) per row, length = rows. */
    rowColors: ReadonlyArray<readonly [number, number, number]>;
    /** Cells with value >= alertAt get a glowing red roof. Infinity = no alerts. */
    alertAt: number;
    /**
     * false: one building per cell on that cell's footprint (a bar grid).
     * true: one tower per column, its segments stacked bottom-to-top in row order, each
     * segment as tall as its value (a stacked bar chart). The tower stands on the column's
     * footprint (the column's x/width, centred vertically on the table).
     */
    stacked: boolean;
    /** The chart is being rearranged on purpose (not a live update): let the bars scramble. */
    playful?: boolean;
};

export type BarPick = {
    row: number;
    col: number;
    /** Where the hovered roof is on screen, CSS px from the canvas top-left (for a tooltip). */
    screenX: number;
    screenY: number;
};

export type BarPointer = {
    /** CSS px, origin at the canvas top-left. */
    x: number;
    y: number;
    vx: number;
    vy: number;
    down: boolean;
    inside: boolean;
};

export type BarFrame = {
    /** Seconds since the host started. */
    time: number;
    /** Seconds since the previous render, clamped to [0, 0.05]. */
    dt: number;
    /** Canvas size in CSS px; the drawing buffer is round(width * dpr) x round(height * dpr). */
    width: number;
    height: number;
    dpr: number;
    /**
     * The live page, uploaded by the host this frame. TEXTURE_2D, RGBA8, opaque, LINEAR,
     * CLAMP_TO_EDGE. Texture coordinate v = 0 is the TOP of the page (no UNPACK_FLIP_Y). The
     * texture covers the whole page: u = x / pageWidth, v = y / pageHeight.
     */
    pageTexture: WebGLTexture;
    pointer: BarPointer;
};

export interface BarRenderer {
    /** Called before the first render and whenever the canvas size changes. */
    resize(width: number, height: number, dpr: number): void;
    /**
     * Cheap; called whenever the data, the layout or the stacked mode changes (often: every few
     * seconds while live). Building heights must animate toward their new values.
     */
    setScene(scene: BarScene): void;
    /**
     * Ease the camera back to its default pose (slightly oblique, from a corner, about 48 degrees
     * elevation). Takes the shortest way round: never unwinds a full turn.
     */
    resetView(): void;
    /** Multiply the camera distance by `factor` (< 1 zooms in), clamped to a sane range. */
    zoomBy(factor: number): void;
    /** Slowly spin the board like a turntable until the user drags or calls this with false. */
    setAutoRotate(on: boolean): void;
    /** Whether the first data opens with the flying camera shot (on by default). */
    setIntro(on: boolean): void;
    /** The angle and zoom the board is currently viewed at, or null while the opening shot plays. */
    getView(): { yaw: number; pitch: number; zoom: number } | null;
    /** Where the view starts (and where the opening shot ends). yaw is from the usual angle. */
    setHomeView(view: { yaw: number; pitch: number; zoom: number }): void;
    /**
     * Draw one frame to the default framebuffer. Returns the cell under the pointer, if any.
     * On return: framebuffer null bound, viewport (0, 0, canvas.width, canvas.height), BLEND /
     * DEPTH_TEST / STENCIL_TEST / SCISSOR_TEST / CULL_FACE disabled, no VAO bound,
     * ACTIVE_TEXTURE = TEXTURE0.
     */
    render(frame: BarFrame): BarPick | null;
    /** Delete every GL object the renderer created. */
    dispose(): void;
}

/** May throw an Error (with a readable message) if the GPU lacks something it needs. */
export type BarRendererFactory = (gl: WebGL2RenderingContext) => BarRenderer;
