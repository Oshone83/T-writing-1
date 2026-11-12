// simulate-lost-event.js — makes the app "forget" one webhook-delivered event, so reconcile.js
// has something to recover. Deletes that event's rows from processed_events and seen.
//
//   node simulate-lost-event.js                 the most recent payment_intent.succeeded delivery
//   node simulate-lost-event.js --event evt_…
import { parseArgs } from 'node:util';
import { isMain } from './lib/env.js';
import { openDb } from './lib/db.js';

export function forgetEvent(db, eventId) {
  const row = eventId
    ? db.prepare("SELECT event_id, payment_id FROM deliveries WHERE event_id = ? LIMIT 1").get(eventId)
    : db.prepare(
        "SELECT event_id, payment_id FROM deliveries WHERE event_type = 'payment_intent.succeeded' " +
        'ORDER BY received_ms DESC LIMIT 1'
      ).get();
  if (!row) throw new Error(eventId ? `no delivery recorded for ${eventId}` : 'no webhook deliveries recorded yet');

  const forget = db.transaction(() => {
    const a = db.prepare('DELETE FROM processed_events WHERE event_id = ?').run(row.event_id).changes;
    const b = db.prepare('DELETE FROM seen WHERE id = ? AND method IN (\'webhook\', \'reconcile\')').run(row.payment_id).changes;
    return { processedEventsDeleted: a, seenDeleted: b };
  });
  return { ...row, ...forget() };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { event: { type: 'string' } } });
  const r = forgetEvent(openDb(), values.event);
  console.log(`forgot ${r.event_id} (payment ${r.payment_id}): ` +
    `${r.processedEventsDeleted} processed_events row, ${r.seenDeleted} seen row deleted`);
  console.log('Now run: node reconcile.js');
}
