/**
 * In-process event bus for live admin telemetry.
 *
 * The SSE endpoint (`/api/admin/telemetry`) subscribes here and forwards
 * whatever the server is already recording — each committed audit-ledger entry
 * is broadcast as an `audit.entry` event. The bus is intentionally small and
 * fail-open:
 *
 * - Listeners are kept in a plain Set and notified synchronously, so a
 *   committed audit entry is observable even if no client is connected.
 * - One throwing listener never breaks the others or the publishing call: the
 *   broadcast iterates a snapshot of the listeners and swallows per-listener
 *   errors.
 * - There is a hard listener cap so a pile-up of stale connections cannot
 *   exhaust memory; the subscriber API returns an unsubscribe handle that the
 *   SSE stream calls when the client disconnects.
 *
 * This carries no PHI: entries are trimmed to chain/bookkeeping fields (the
 * same projection an operator dashboard would show), never record bodies.
 */

/** The compact, PHI-free projection broadcast to admin listeners. */
export type TelemetryAuditEntry = {
  seq: number;
  action: string;
  resourceType: string;
  resourceId: string;
  actorRole: string;
  actorId: string;
  detail?: string;
  occurredAt: string;
};

export type TelemetryEnvelope = {
  type: "audit.entry";
  data: TelemetryAuditEntry;
};

export type TelemetryListener = (event: TelemetryEnvelope) => void;

/** Guards against connection pile-ups from stale EventSource clients. */
export const MAX_TELEMETRY_LISTENERS = 64;

/**
 * The bus lives on `Symbol.for` instead of a module-scoped set so that every
 * consumer sees the same registry no matter how the bundler compiled it. Next.js
 * compiles route handlers and server actions into separate module graphs even
 * within `next dev`, and a plain module singleton would then give publishers and
 * subscribers two independent buses. `Symbol.for` is process-global, so the hub
 * is shared across those chunk boundaries.
 */
const BUS_KEY = Symbol.for("carepulse.telemetry.bus");

type TelemetryBus = {
  listeners: Set<TelemetryListener>;
};

const getBus = (): TelemetryBus => {
  const existing = (globalThis as Record<PropertyKey, unknown>)[
    BUS_KEY
  ] as TelemetryBus | undefined;

  if (existing) return existing;

  const created: TelemetryBus = { listeners: new Set() };
  Object.defineProperty(globalThis, BUS_KEY, {
    value: created,
    configurable: true,
    writable: true,
  });

  return created;
};

/**
 * Registers a listener and returns an unsubscribe handle. Throws once the
 * cap is reached so an out-of-control stream cannot quietly drop telemetry.
 */
export const subscribeTelemetry = (listener: TelemetryListener): (() => void) => {
  const { listeners } = getBus();

  if (listeners.size >= MAX_TELEMETRY_LISTENERS) {
    throw new Error("telemetry listener limit reached");
  }

  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Broadcasts to a snapshot of listeners; a broken listener is isolated. */
export const publishTelemetry = (event: TelemetryEnvelope): void => {
  const { listeners } = getBus();

  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A listener failing must never break the publisher or other listeners.
    }
  }
};

/** Broadcasts a committed audit entry as a telemetry event. */
export const publishAuditEntry = (entry: TelemetryAuditEntry): void => {
  publishTelemetry({ type: "audit.entry", data: entry });
};

/** For tests: drops every listener so suites start from a clean bus. */
export const clearTelemetryListeners = (): void => {
  getBus().listeners.clear();
};