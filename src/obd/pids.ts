export type MetricStatus = 'fresh' | 'stale' | 'no-data' | 'parse-error' | 'unsupported';

export type DashboardMetric = {
  pid: string;
  label: string;
  shortLabel: string;
  unit: string;
  value: number | null;
  displayValue: string;
  status: MetricStatus;
  updatedAt?: number;
  raw?: string;
};

export type ParsedObdValue = {
  pid: string;
  label: string;
  shortLabel: string;
  unit: string;
  value: number;
  displayValue: string;
};

export type PidDefinition = {
  command: string;
  marker: string;
  label: string;
  shortLabel: string;
  unit: string;
  bytes: number;
  precision?: number;
  group: 'fast' | 'slow';
  parse: (bytes: number[]) => number;
};

const percent = (value: number) => value * 100 / 255;

export const PID_DEFINITIONS: PidDefinition[] = [
  {
    command: '010C',
    marker: '410C',
    label: 'Engine RPM',
    shortLabel: 'RPM',
    unit: 'rpm',
    bytes: 2,
    group: 'fast',
    parse: ([a, b]) => ((a * 256) + b) / 4,
  },
  {
    command: '010D',
    marker: '410D',
    label: 'Vehicle speed',
    shortLabel: 'Speed',
    unit: 'km/h',
    bytes: 1,
    group: 'fast',
    parse: ([a]) => a,
  },
  {
    command: '0105',
    marker: '4105',
    label: 'Coolant temperature',
    shortLabel: 'Coolant',
    unit: 'C',
    bytes: 1,
    group: 'slow',
    parse: ([a]) => a - 40,
  },
  {
    command: '010F',
    marker: '410F',
    label: 'Intake air temperature',
    shortLabel: 'Intake',
    unit: 'C',
    bytes: 1,
    group: 'slow',
    parse: ([a]) => a - 40,
  },
  {
    command: '0111',
    marker: '4111',
    label: 'Throttle position',
    shortLabel: 'Throttle',
    unit: '%',
    bytes: 1,
    precision: 1,
    group: 'fast',
    parse: ([a]) => percent(a),
  },
  {
    command: '010B',
    marker: '410B',
    label: 'Intake manifold pressure',
    shortLabel: 'MAP',
    unit: 'kPa',
    bytes: 1,
    group: 'slow',
    parse: ([a]) => a,
  },
  {
    command: '0104',
    marker: '4104',
    label: 'Calculated engine load',
    shortLabel: 'Load',
    unit: '%',
    bytes: 1,
    precision: 1,
    group: 'fast',
    parse: ([a]) => percent(a),
  },
  {
    command: '0142',
    marker: '4142',
    label: 'Control module voltage',
    shortLabel: 'Voltage',
    unit: 'V',
    bytes: 2,
    precision: 2,
    group: 'slow',
    parse: ([a, b]) => ((a * 256) + b) / 1000,
  },
  {
    command: '0143',
    marker: '4143',
    label: 'Absolute load',
    shortLabel: 'Abs load',
    unit: '%',
    bytes: 2,
    precision: 1,
    group: 'slow',
    parse: ([a, b]) => ((a * 256) + b) * 100 / 255,
  },
  {
    command: '0145',
    marker: '4145',
    label: 'Relative throttle',
    shortLabel: 'Rel throttle',
    unit: '%',
    bytes: 1,
    precision: 1,
    group: 'slow',
    parse: ([a]) => percent(a),
  },
  {
    command: '011F',
    marker: '411F',
    label: 'Run time',
    shortLabel: 'Runtime',
    unit: 's',
    bytes: 2,
    group: 'slow',
    parse: ([a, b]) => (a * 256) + b,
  },
  {
    command: '0133',
    marker: '4133',
    label: 'Barometric pressure',
    shortLabel: 'Baro',
    unit: 'kPa',
    bytes: 1,
    group: 'slow',
    parse: ([a]) => a,
  },
];

export const CORE_DASHBOARD_PIDS = [
  '010C',
  '010D',
  '0105',
  '0111',
  '0142',
  '0104',
  '010F',
  '010B',
];

export const PID_BY_COMMAND = new Map(PID_DEFINITIONS.map(definition => [
  definition.command,
  definition,
]));

export const initialMetric = (definition: PidDefinition): DashboardMetric => ({
  pid: definition.command,
  label: definition.label,
  shortLabel: definition.shortLabel,
  unit: definition.unit,
  value: null,
  displayValue: '--',
  status: 'stale',
});

export const formatValue = (definition: PidDefinition, value: number) => {
  if (definition.precision !== undefined) {
    return value.toFixed(definition.precision);
  }

  return String(Math.round(value));
};
