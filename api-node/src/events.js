// Writes one row to the order timeline. `db` is a pool or a client inside
// a transaction. Returns false when client_event_id was already recorded,
// which means this is a retry of an update that already happened.
async function recordEvent(db, {
  orderId, stopId = null, type, actorType, actorId = null,
  clientEventId = null, occurredAt = null,
}) {
  const { rowCount } = await db.query(
    `INSERT INTO order_events
       (order_id, stop_id, event_type, actor_type, actor_id, client_event_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT (client_event_id) DO NOTHING`,
    [orderId, stopId, type, actorType, actorId, clientEventId, occurredAt],
  );
  return rowCount === 1;
}

function staffActor(req) {
  return { actorType: 'user', actorId: req.user.id };
}

module.exports = { recordEvent, staffActor };
