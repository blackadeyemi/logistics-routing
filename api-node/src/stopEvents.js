// What happens after a stop update has been committed, whoever made it
// (the driver app, or a dispatcher recording a phoned-in update): the
// dashboard hears about it at once, and the customer gets an SMS when the
// driver sets off to them and when the parcel is delivered.
const { publish } = require('./realtime');
const { notifyLater } = require('./sms');

function afterStopUpdate(route, stopId, action, replayed) {
  if (replayed || !route) return;
  const stop = route.stops.find((s) => Number(s.id) === Number(stopId));
  publish({ type: 'stop', route_id: Number(route.id), stop_id: Number(stopId), order_id: stop ? Number(stop.order_id) : null, action, route_status: route.status });
  if (!stop || stop.stop_type !== 'dropoff') return;
  if (action === 'start') notifyLater(Number(stop.order_id), 'en_route');
  if (action === 'complete') notifyLater(Number(stop.order_id), 'delivered');
}

module.exports = { afterStopUpdate };
