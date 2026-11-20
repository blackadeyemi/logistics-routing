import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { StopsMap, useMapsEnabled } from '../components/maps';
import { Mark } from '../components/ui';
import { ApiError, request } from '../lib/api';
import { fmtDateTime, fmtTime } from '../lib/format';
import { configureMaps } from '../lib/maps';
import type { EventType, PublicTracking } from '../lib/types';

const STEPS: { key: EventType; label: string }[] = [
  { key: 'created', label: 'Order received' },
  { key: 'assigned', label: 'Driver assigned' },
  { key: 'picked_up', label: 'Picked up' },
  { key: 'en_route', label: 'On the way to you' },
  { key: 'delivered', label: 'Delivered' },
];

const HEADLINE: Record<string, string> = {
  pending: 'We have your order',
  assigned: 'A driver has your order',
  picked_up: 'Your parcel has been picked up',
  en_route: 'Your parcel is on the way',
  delivered: 'Delivered',
  cancelled: 'This order was cancelled',
};

/**
 * The page a customer opens from their SMS. Public, no login: the link's
 * token is the key. Refreshes itself every minute.
 */
export function Track() {
  const { token = '' } = useParams();
  const [data, setData] = useState<PublicTracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const maps = useMapsEnabled();

  const load = useCallback(async () => {
    try {
      const d = await request<PublicTracking>('staff', `/public/track/${encodeURIComponent(token)}`, { quiet: true });
      if (d.maps?.api_key) configureMaps({ key: d.maps.api_key, mapId: d.maps.map_id });
      setData(d);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'This tracking link is not valid. Check the link in your SMS.' : 'Could not load your delivery. Check your connection and try again.');
    }
  }, [token]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const reached = new Map((data?.events ?? []).map((e) => [e.type, e.at]));
  const active = data && !['delivered', 'cancelled'].includes(data.status);
  const loc = data?.driver?.location;

  return (
    <div className="track-page">
      <header className="track-head">
        <Mark size={30} />
        <strong>{data?.company || 'Delivery tracking'}</strong>
      </header>
      <main className="track-main">
        {error && <div className="alert alert-warning">{error}</div>}
        {!data && !error && <div className="card card-pad">Loading your delivery…</div>}
        {data && (
          <>
            <section className="card card-pad track-hero">
              <p className="text-sm text-muted mb-0">Order #{data.order_number}{data.customer_first_name && ` · for ${data.customer_first_name}`}</p>
              <h1>{data.failed_attempt ? 'We could not deliver today' : HEADLINE[data.status] ?? 'Your delivery'}</h1>
              {active && data.eta && (
                <div className="track-eta">
                  <Icon name="clock" />
                  <div>
                    <div className="track-eta-time">Around {fmtTime(data.eta.at)}</div>
                    <div className="text-sm text-muted">{data.eta.minutes <= 1 ? 'Arriving now' : `In about ${data.eta.minutes} minutes`}{data.eta.based_on !== 'driver' && ', an estimate until the driver is on the move'}</div>
                  </div>
                </div>
              )}
              {data.window && active && <p className="text-sm mb-0">Your delivery window: {data.window.after ? `after ${data.window.after}` : ''}{data.window.after && data.window.before ? ' and ' : ''}{data.window.before ? `before ${data.window.before}` : ''}</p>}
              {data.failed_attempt && <p className="mb-0">The driver could not complete the delivery. We will contact you to arrange a new time.</p>}
              {data.driver && active && <p className="text-sm mb-0">Your driver: {data.driver.first_name}{data.driver.vehicle && ` (${data.driver.vehicle})`}</p>}
              <p className="text-sm text-muted mb-0">{data.status === 'delivered' ? 'Delivered to' : 'Delivering to'} {data.dropoff_address}</p>
            </section>

            {maps && loc && active && (
              <section className="card track-map">
                <StopsMap points={[{ id: 'driver', kind: 'pickup', label: 'Driver', location: loc, title: 'Your driver' }]} line={false} height={260} />
                <p className="text-xs text-muted live-note">Driver position {loc.age_s < 90 ? 'just now' : `${Math.round(loc.age_s / 60)} min ago`}.</p>
              </section>
            )}

            <section className="card card-pad">
              <ol className="track-steps">
                {STEPS.map((s) => {
                  const at = reached.get(s.key);
                  return (
                    <li key={s.key} className={at ? 'done' : ''}>
                      <span className="track-dot">{at && <Icon name="check" size={12} />}</span>
                      <span className="grow">{s.label}</span>
                      {at && <span className="text-xs text-muted">{fmtDateTime(at)}</span>}
                    </li>
                  );
                })}
              </ol>
            </section>
            <p className="text-xs text-muted track-foot">This page updates by itself every minute.</p>
          </>
        )}
      </main>
    </div>
  );
}
