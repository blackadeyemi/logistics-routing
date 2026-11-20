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
  pickup_notes: string | null;
  dropoff_notes: string | null;
  weight_kg: number;
  /** Delivery window in Lagos time, "HH:MM", either end optional. */
  dropoff_after: string | null;
  dropoff_before: string | null;
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
  notes: string | null;
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
  ai: {
    api_key_set: boolean;
    /** Masked, for example "sk-ant-…AbCd". The key itself never reaches the browser. */
    api_key_hint: string | null;
    key_source: 'settings' | 'env' | 'none';
    key_unreadable: boolean;
    model: string;
    model_source: 'settings' | 'env' | 'none';
    can_save_secrets: boolean;
    updated_at: string | null;
    updated_by: string | null;
  };
}

export interface AiModel {
  id: string;
  display_name: string;
  created_at: string | null;
  max_input_tokens: number | null;
  max_tokens: number | null;
}

/** POST /ai/extract-order: a WhatsApp message read into a draft order. */
export interface ExtractedDraft {
  draft: {
    customer_name: string | null;
    customer_phone: string | null;
    pickup_address: string | null;
    pickup_notes: string | null;
    dropoff_address: string | null;
    dropoff_notes: string | null;
  };
  phone_valid: boolean;
  missing: string[];
  warnings: string[];
  model: string;
  usage: { input_tokens: number; output_tokens: number; duration_ms: number };
}

// ---- Copilot ----

export type ActionStatus = 'proposed' | 'confirmed' | 'rejected' | 'failed';

export interface AgentAction {
  id: number;
  conversation_id: number;
  tool: string;
  arguments: Record<string, unknown>;
  summary: string;
  preview: {
    driver?: string;
    route_date?: string;
    stops?: { n: number; stop_id: number; type: StopType; address: string; order_id: number; customer: string }[];
    /** propose_optimized_routes: the optimization run and its routes. */
    run_id?: number;
    routes?: { driver: string; vehicle: string; stops: number; km: number; orders: number[] }[];
    [k: string]: unknown;
  } | null;
  status: ActionStatus;
  result: { message?: string; error?: string; order_id?: number; route_id?: number } | null;
  created_at: string;
  decided_at: string | null;
}

export interface KnowledgeSource {
  ref: string;
  title: string;
  source_type: 'sop' | 'stop_note';
  source_id: number;
  order_id: number | null;
  content: string;
}

export type CopilotItem =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; id?: string; name: string; label: string; status: 'running' | 'done' | 'error'; detail?: string }
  | { type: 'proposal'; action_id: number }
  | { type: 'sources'; items: KnowledgeSource[] }
  | { type: 'error'; message: string };

export interface Conversation {
  id: number;
  title: string | null;
  display: CopilotItem[];
  actions: AgentAction[];
  updated_at: string;
}

export interface KnowledgeDocument {
  id: number;
  title: string;
  body: string;
  chunks: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeHit {
  id: number;
  source_type: 'sop' | 'stop_note';
  source_id: number;
  title: string;
  content: string;
  similarity: number;
  score: number;
  order_id: number | null;
}

// ---- Route optimization (Phase 3) ----

export interface PlanStop {
  stop_id: number;
  order_id: number;
  type: StopType;
  address: string;
  customer: string;
  eta: string;
}

export interface OptimizationRun {
  id: number;
  route_date: string;
  distance_provider: string;
  status: 'proposed' | 'accepted' | 'discarded' | 'stale';
  solve_ms: number;
  manual_km: number;
  proposed_km: number;
  created_at: string;
  created_by: string | null;
  manual: {
    routes: { route_id: number; driver_id: number; driver: string; stops: number; distance_km: number }[];
    summary: {
      manual: { routes: number; orders: number; km: number };
      proposed: { routes: number; orders: number; km: number; km_for_manual_orders: number };
      unplanned_orders_added: number;
      locked_drivers: number[];
    };
  };
  proposed: {
    driver_id: number;
    driver: string;
    vehicle: string;
    capacity_kg: number;
    peak_load_kg: number;
    distance_km: number;
    stop_ids: number[];
    stops: PlanStop[];
  }[];
  unassigned: { order_id: number; customer: string; reason: string }[];
}
