// simulate-lost-event.js — makes the app "forget" one webhook-delivered event, so reconcile.js
// has something to recover. Deletes that event's rows from processed_events and seen.
//
// It only touches payments created for this purpose (phase 'lost-event'), so it can never
// change a side-by-side or outage measurement:
//
//   node create-payments.js --count 1 --phase lost-event   (receiver running; wait for "new … succeeded")
//   node simulate-lost-event.js                            forgets that payment's event
//   node reconcile.js                                      recovers it
//
//   node simulate-lost-event.js --event evt_…              a specific lost-event-phase event
import { parseArgs } from 'node:util';
import { isMain } from './lib/env.js';
import { openDb } from './lib/db.js';

export const LOST_EVENT_PHASE = 'lost-event';

export function forgetEvent(db, eventId) {
  const base =
    "SELECT d.event_id, d.payment_id, p.phase FROM deliveries d LEFT JOIN payments p ON p.id = d.payment_id " +
    "WHERE d.event_type = 'payment_intent.succeeded' ";
  const row = eventId
    ? db.prepare(base + 'AND d.event_id = ? LIMIT 1').get(eventId)
    : db.prepare(base + 'AND p.phase = ? ORDER BY d.received_ms DESC LIMIT 1').get(LOST_EVENT_PHASE);

  if (!row) {
    throw new Error(eventId
      ? `no payment_intent.succeeded delivery recorded for ${eventId}`
      : `no delivered '${LOST_EVENT_PHASE}' payment yet. With the receiver running, first run: ` +
        `node create-payments.js --count 1 --phase ${LOST_EVENT_PHASE}`);
  }
  if (row.phase !== LOST_EVENT_PHASE) {
    throw new Error(`refusing: ${row.event_id} belongs to a '${row.phase ?? 'unknown'}' payment. ` +
      `Only '${LOST_EVENT_PHASE}' payments may be forgotten, so real measurements stay intact.`);
  }

  const forget = db.transaction(() => {
    const a = db.prepare('DELETE FROM processed_events WHERE event_id = ?').run(row.event_id).changes;
    const b = db.prepare("DELETE FROM seen WHERE id = ? AND method IN ('webhook', 'reconcile')").run(row.payment_id).changes;
    db.prepare('INSERT INTO simulated_losses (event_id, payment_id, forgotten_ms) VALUES (?, ?, ?)')
      .run(row.event_id, row.payment_id, Date.now());
    return { processedEventsDeleted: a, seenDeleted: b };
  });
  return { event_id: row.event_id, payment_id: row.payment_id, ...forget() };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { event: { type: 'string' } } });
  const r = forgetEvent(openDb(), values.event);
  console.log(`${new Date().toISOString()} forgot ${r.event_id} (payment ${r.payment_id}): ` +
    `${r.processedEventsDeleted} processed_events row, ${r.seenDeleted} seen row deleted`);
  console.log('Now run: node reconcile.js');
}
