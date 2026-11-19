# Timeseries Alternative: user guide

A Datadog metrics query drawn as a 3D bar chart. Each row is a series, each column a stretch of
time, and a box stands on every cell, as tall as its value. Use it on its own, or add it to a
dashboard as a widget.

> It needs a browser with HTML-in-Canvas (Chrome 157 or newer). Anywhere else it shows the same
> table, flat.

## Reading the chart

- **Rows** are the series, strongest first (by their maximum in the time frame). With a `by {host}`
  group there is one row per host.
- **Columns** are time, the oldest on the left. The times are along the bottom edge.
- **A bar's height** is its value, starting from zero and relative to the tallest bar on screen. The
  scale follows the data: when a taller value arrives, the others get shorter.
- **Point at a bar** for its exact value, its series and its time. The number on its roof is the
  same value, rounded.

## The query (top left)

It works like the query box of a Datadog Timeseries widget:

```
 metric name   from  [filters]   avg  by  [groups]
```

- Type a metric name and pick one from the list. `from` takes tags such as `env:prod`; `by` takes
  tag keys such as `host`. Both complete as you type.
- Pick another aggregation (`avg`, `sum`, `min`, `max`) from the box beside `by`.
- `</>` turns the box into plain text, for anything the boxes cannot say, such as
  `avg:system.cpu.user{env:prod} by {host}`. A query that cannot be read is not sent, and the
  message says where it goes wrong. The text is also what you copy into a widget's settings
  (Edit Graph) to chart the same query on a dashboard.

## The time frame (top right)

Click the box and type what you would type in a Datadog time selector:

| You type | You get |
| --- | --- |
| `5m`, `2 days`, `1 week`, `3 mo` | The last 5 minutes, 2 days, ... (sliding) |
| `since Jan 1`, `10am to now` | From then until now (growing) |
| `Jan 1 - Jan 5`, `6:00 am - 1:00 pm` | A fixed window |
| `today`, `yesterday`, `last week`, `2 weeks ago` | A calendar day, week, month or year |

The list under the box follows what you type: `5` offers minutes, hours, days, weeks and months.
A time frame is between 1 minute and 1 year.

The three buttons beside it:

- **⏪** moves the window back by its own length (and leaves the live tail).
- **⏸ / ▶** pauses the live tail, or resumes it. Blue means it is live; a live chart refreshes
  every 15 seconds.
- **⏩** moves the window forward by its length. Caught up with now, it returns to live.

The columns follow the rollup Datadog itself picks for the time frame, so a short range has few,
fine columns and a long one has up to 30. The same time frame, query and options go into the
address, so a link opens the same view.

## The tools (bottom right)

| Control | What it does |
| --- | --- |
| **Stack** | One tower per time bucket with the series stacked inside it, as a stacked bar chart. The table shrinks to a Total row and a legend names the colours |
| **Sort** | Orders the rows: by value (highest or lowest first), or by one of the tags the series are grouped by (A to Z, Z to A). The tag choices appear when the query has a `by {...}`. Top N still picks the strongest series; Sort only orders them. Kept in the link |
| **Top 5 / 10 / 25 / 50** | How many series to draw. The rest are left out |
| **Alert ≥** | Roofs at or above this value glow red |
| **Sound** | (Remembered in your browser.) A short note when the pointer reaches a bar (higher for taller bars), a chime when new data arrives, a clatter of blocks whenever the chart moves because you Stack or un-Stack, change Top N, or change the query, aggregation or time frame |
| **Spin** | Slowly turns the board. Dragging pauses it for a few seconds |
| **Reset view** | Back to the starting angle |
| **Image** | Shows the chart as a picture. Right-click it to save it (a page inside Datadog cannot use the clipboard) |
| **ⓘ** | The short version of this guide, with links to the repository and the author |

**The view:** the chart opens with a close-up at the front corner, flies low along the bars, then pulls back to the usual view (touch it to take over). As a dashboard widget it simply appears, with no opening shot. Drag to turn the board, scroll to zoom. The angle and zoom you leave it at are remembered in your browser. Zoomed in, the board cannot be tipped flat: the view lifts by itself so the camera stays above the bars. It tips between nearly flat and nearly top-down
but never goes beyond them, and you can go all the way round.

## On a dashboard

Add the app to a dashboard as a widget. When you add or edit it, Datadog asks for:

| Setting | |
| --- | --- |
| **Metrics query** | The query to chart, saved with the widget, so every device shows the same chart. On the widget the query shows as a line of text at the top left; click it to open the query builder and try another (not saved): switch it to text with `</>`, select the text and copy it here |
| **Number of series** | 5, 10, 25 or 50 |
| **Stacked** | Stack the series |
| **Sort order** | `value` (highest first), `value:asc`, or a group tag such as `host` or `host:desc` |
| **Spin** | Slowly turn the board |
| **Alert at or above** | The red-roof threshold; 0 is off |

These are saved with that widget, so two widgets on one dashboard can show two different metrics,
and every time the dashboard opens they are the same. The widget follows the dashboard's own time
selector (live or fixed), so it shows no time frame box, no query bar, no Top N and no Alert box:
those are set here. Stack, Sort and Spin start as set here, and their buttons stay on the widget
for trying things out: what you press is not saved and is gone when the page is reloaded. Sound,
Reset view and Image are the viewer's own.

## When something looks wrong

- **A message at the bottom left.** The query failed, or there is no data: check the metric name,
  the filters and the time frame.
- **The table shows flat, with no 3D.** The browser has no HTML-in-Canvas (it needs Chrome 157+),
  or the GPU could not start the chart: the message in the bottom right says which.
- **The newest column is missing.** A live tail leaves the newest bucket out until its data arrives.

## For developers

The source is in the [repository](https://github.com/kyoppe/datadog-app-playground).
The short version of this guide is behind the ⓘ button in the app.

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run upload
```

| File | Role |
| --- | --- |
| `src/TimeseriesAlternative.tsx` | The page: toolbar, the table, the paint loop, widget and dashboard wiring |
| `src/bars/barRenderer.ts` | The WebGL renderer: board, table top, bars, shadows, camera, picking |
| `src/bars/types.ts` | The contract between the page and the renderer |
| `src/QueryBuilder.tsx`, `src/TimeFrameSelector.tsx` | The query and time frame boxes |
| `src/timeFrame.ts`, `src/queryCheck.ts` | Reading typed time frames; checking queries and explaining errors |
| `src/metrics.backend.ts`, `src/metricSearch.backend.ts` | Backend functions: run the query, complete names and tags |
| `src/parameters.ts` | The widget's settings |

Backend functions are handed to React Query wrapped (`queryFn: () => fn()`), never bare: the app
bridge cannot clone the `AbortSignal` React Query would pass them. A dashboard cannot be embedded in
a Datadog App (see [`dashboard-alternative`](../dashboard-alternative/README.md)), which is why this
app draws its own chart from the metric data.
