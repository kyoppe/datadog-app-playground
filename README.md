# Apps Intro Alternative

A small Datadog App experiment built with React, TypeScript, HTML-in-Canvas, and WebGL.

It recreates the Datadog Apps Intro experience with interactive water, liquid glass, ink, and jelly effects. It is a demo and is not intended as a production use case.

## Local development

```bash
cd apps/apps-intro-alternative-under-water
npm install
npm run dev -- --org <org-uuid>
```

## Verification

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Datadog documentation

- [Datadog Apps](https://docs.datadoghq.com/actions/datadog_apps/) - local development, upload, and publishing
- [App Builder](https://docs.datadoghq.com/actions/app_builder/) - App Builder concepts and components
- [React Renderer](https://docs.datadoghq.com/actions/app_builder/components/react_renderer/) - custom React UI in App Builder
