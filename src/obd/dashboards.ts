export type BikeDashboard = {
  id: string;
  label: string;
  commands: string[];
};

export const BIKE_DASHBOARDS: BikeDashboard[] = [
  {
    id: 'ride',
    label: 'Ride',
    commands: ['010C', '010D'],
  },
  {
    id: 'engine',
    label: 'Engine',
    commands: ['0105', '010F', '010B', '0142'],
  },
  {
    id: 'load',
    label: 'Load',
    commands: ['0111', '0104', '0143', '0145'],
  },
  {
    id: 'trip',
    label: 'Trip',
    commands: ['011F', '0133'],
  },
];

export const DEFAULT_DASHBOARD_ID = BIKE_DASHBOARDS[0].id;

export const DASHBOARD_PIDS = Array.from(
  new Set(BIKE_DASHBOARDS.flatMap(dashboard => dashboard.commands)),
);
