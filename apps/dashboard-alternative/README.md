# Dashboard Alternative (development stopped)

An experiment: show a real Datadog dashboard in an `<iframe>` under the water / ink / jelly
effects from [`apps-intro-alternative`](../apps-intro-alternative/), with a selector for the
organization's dashboards.

**It does not work, and cannot, so development was stopped on 2026-11-19.** The code is kept as a
reference. The uploaded app is meant to be deleted from Datadog.

## Why a dashboard cannot be embedded

Both ends refuse the frame:

| Side | Header | Effect |
| --- | --- | --- |
| The app (`https://<app-id>.us1.datadoguserapps.com`) | `Content-Security-Policy: frame-src 'none'` | The app cannot open any iframe. |
| Datadog pages (`app.datadoghq.com`, `<org>.datadoghq.com`) | `X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'` | Only same-origin pages can frame them. |

Two things that looked promising and are not true:

- **The app is not same-origin with Datadog.** It is served from `datadoguserapps.com`, so a
  relative URL such as `/dashboard/<id>/<slug>` resolves to the app's own host (which only allows
  `*.datadoghq.com` parents) instead of the Datadog site. The browser logs:
  `Framing 'https://<app-id>.us1.datadoguserapps.com/' violates ... frame-ancestors ...`.
- **An absolute URL does not help**, because of the two headers above.

Even a framable cross-origin iframe could not be warped by the WebGL effects: HTML-in-Canvas does
not hand over cross-origin pixels. The best it could do was sit on top of the canvas.

## What does work

- Listing the organization's dashboards from a backend function:
  `listDashboards` from `@datadog/action-catalog/dd/dashboard` (`src/dashboards.backend.ts`).
- Saving a default dashboard in a Datadog datastore and reading it back
  (`src/defaultDashboard.backend.ts`). The datastore needs a string primary key column named
  `key`; its ID goes in `DATASTORE_ID`.
- The effects and the effect switcher (copied from `apps-intro-alternative`).

## Gotcha worth remembering

Never pass a backend function straight to React Query (`queryFn: listOrgDashboards`). React Query
hands its callback an `AbortSignal`, which the embedded app bridge cannot clone, so the call fails
and the UI just says it could not load. Wrap it: `queryFn: () => listOrgDashboards()`.

## If this is ever picked up again

The only way to get dashboard content under the effects is to draw it in the app itself: query the
data from a backend function (metrics, monitors, ...) and render it as ordinary HTML, which the
effects can then warp like the rest of the page. That means re-creating widgets, not embedding
dashboards.
