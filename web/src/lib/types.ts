export interface LatLng {
  lat: number;
  lng: number;
}

export type Role = 'admin' | 'dispatcher';

export interface User {
  id: number;
  email: string;
  full_name: string;
  role: Role;
  created_at?: string;
}

export type VehicleType = 'bike' | 'keke' | 'van' | 'truck';
export type VehicleStatus = 'active' | 'maintenance' | 'inactive';

export interface Vehicle {
  id: number;
  type: VehicleType;
  plate_number: string;
  capacity_kg: number | null;
  status: VehicleStatus;
  created_at: string;
}

export interface Driver {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  vehicle_id: number | null;
  status: 'active' | 'inactive';
  has_pin: boolean;
  vehicle: Pick<Vehicle, 'id' | 'type' | 'plate_number' | 'capacity_kg' | 'status'> | null;
  created_at: string;
}

export type OrderStatus = 'pending' | 'assigned' | 'picked_up' | 'en_route' | 'delivered' | 'cancelled';

export interface Order {
  id: number;
  customer_name: string;
  customer_phone: string;
  pickup_address: string;
  pickup_location: LatLng | null;
  dropoff_address: string;
  dropoff_location: LatLng | null;
  status: OrderStatus;
  route_id: number | null;
  pickup_stop_id: number;
  dropoff_stop_id: number;
  created_at: string;
}

export type EventType =
  | 'created' | 'updated' | 'assigned' | 'unassigned' | 'arrived'
  | 'picked_up' | 'en_route' | 'delivered' | 'skipped' | 'cancelled';

export interface OrderEvent {
  id: number;
  stop_id: number | null;
  event_type: EventType;
  actor_type: 'user' | 'driver' | 'system';
  actor_id: number | null;
  occurred_at: string;
  created_at: string;
}

export interface OrderDetail extends Order {
  events: OrderEvent[];
}

export type StopStatus = 'pending' | 'arrived' | 'completed' | 'skipped';
export type StopType = 'pickup' | 'dropoff';

export interface RouteStop {
  id: number;
  order_id: number;
  sequence_number: number;
  stop_type: StopType;
  address: string;
  location: LatLng | null;
  status: StopStatus;
  arrived_at: string | null;
  completed_at: string | null;
  customer_name: string;
  customer_phone: string;
  order_status: OrderStatus;
}

export type RouteStatus = 'planned' | 'in_progress' | 'completed';

export interface RouteSummary {
  id: number;
  driver_id: number | null;
  vehicle_id: number | null;
  route_date: string;
  status: RouteStatus;
  created_at: string;
  driver: { id: number; name: string; phone: string } | null;
  vehicle: { id: number; type: VehicleType; plate_number: string } | null;
  stop_count?: number;
  done_count?: number;
}

export interface Route extends RouteSummary {
  stops: RouteStop[];
}

export interface TodayStats {
  date: string;
  pending: number;
  assigned: number;
  in_transit: number;
  created_today: number;
  delivered_today: number;
  failed_today: number;
  routes_today: number;
  routes_in_progress: number;
  routes_completed: number;
  drivers_active: number;
  drivers_free: number;
  drivers_without_pin: number;
}

export type DriverAction = 'arrive' | 'start' | 'complete' | 'skip';

export interface AppSettings {
  google_maps: {
    api_key: string;
    map_id: string;
    updated_at: string | null;
    updated_by: string | null;
  };
}
