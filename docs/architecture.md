# Architecture

Agent Mesh separates decision logic from host integration.

## Core

The core package receives normalized inputs and returns plans. It does not perform side effects.

Responsibilities:

- normalize policy configuration;
- validate targets and participants;
- classify structured task messages;
- advance task state;
- require explicit run ids where configured;
- suppress duplicates and completed-run replays;
- produce deterministic next-action plans.

## Host Adapter

A host adapter connects the core to a runtime such as OpenClaw.

Responsibilities:

- read private configuration;
- normalize inbound messages;
- load and persist task state;
- call the core planner;
- write audit records;
- perform approved sends or dispatches through host-owned APIs.

## Private Configuration

Deployments provide concrete participants, channel targets, task definitions, allowlists, state paths, feature flags, and audit sinks. These values intentionally stay outside the reusable package.

