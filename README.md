# Partmov

A privacy-first, fully open-source, low-latency co-watching platform for two people — and the
blueprint site that specifies it.

This repository contains the **product spec and technical architecture** for Partmov, published as
a Next.js site. The engineering source of truth is [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md); the
site under `app/` presents the same design.

## What Partmov is

One room, one film, two people, one authoritative clock. A host uploads or selects a licensed
title, sends a single expiring invite link, and both viewers stay on the same frame — start
together, pause for both, invisible drift correction, and quiet recovery when a connection
stumbles. Nothing is public, discoverable, or mined.

## The designed runtime stack

All free software, self-hostable on one machine for the MVP:

| Layer | Choice |
|---|---|
| Client | Next.js + React, hls.js |
| API | Fastify (TypeScript), stateless |
| Realtime | `ws` over WSS, server-authoritative room clock |
| Database | PostgreSQL 16 (metadata, rooms, invites, job queue, audit) |
| Object storage | MinIO (private originals + gated renditions) |
| Media | FFmpeg (3-rung HLS ladder, fMP4, 2 s segments, WebVTT, sprites) |
| Edge | Caddy or Nginx (TLS, signed media gate, optional segment cache) |
| Observability | Prometheus, Grafana OSS, Loki, OpenTelemetry |
| Runtime | Docker Compose, then Kubernetes |

Redis is introduced only when there is more than one sync node. A CDN is always optional.

## Reading order

| Page | Contents |
|---|---|
| `/` | Product in one page: room, sync loop, ten components, stack |
| `/product` | Vision, eight-step user flow, roles, interface principles, non-goals |
| `/architecture` | Service topology, text diagram, media pipeline, storage, deployment, scaling |
| `/sync` | Canonical clock, offset estimation, correction ladder, transitions, buffering |
| `/data` | Nine entities, PostgreSQL DDL, retention policy |
| `/api-spec` | REST endpoints, WebSocket events both directions, error semantics |
| `/security` | Access layers, signed delivery, isolation and deletion, abuse controls, metrics |
| `/ops` | Observability, SLOs and alerts, rate limits, backups, disaster recovery |
| `/mvp` | MVP scope, 8-week build order, acceptance criteria, future enhancements |

## Running this site locally

Requires Node.js 20 or newer.

```bash
npm install
npm run dev     # http://localhost:3000
```

```bash
npm run build   # production build
npm start       # serve the production build
```

## Repository layout

```
app/            Next.js App Router pages, one per blueprint chapter
components/     Shared UI: nav, primitives, architecture diagram, sync visualisation
docs/           BLUEPRINT.md — the full engineering specification
```

## Note on scope

This project is the design artefact. The runtime stack it describes (MinIO, FFmpeg workers,
PostgreSQL, a long-lived WebSocket authority) is intended to run under Docker Compose on a
machine you control, not on a serverless host.
