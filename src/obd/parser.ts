import {
  PID_BY_COMMAND,
  ParsedObdValue,
  formatValue,
} from './pids';

export type ObdParseResult =
  | { ok: true; value: ParsedObdValue }
  | { ok: false; reason: string };

export const normalizeElmResponse = (raw: string, command?: string) => {
  let compact = raw
    .toUpperCase()
    .replace(/SEARCHING\.\.\./g, '')
    .replace(/\s/g, '')
    .replace(/>/g, '');

  if (command) {
    compact = compact.replace(new RegExp(command.toUpperCase(), 'g'), '');
  }

  return compact;
};

export const parseObdResponse = (
  command: string,
  rawOrCleanedResponse: string,
): ObdParseResult => {
  const definition = PID_BY_COMMAND.get(command.toUpperCase());

  if (!definition) {
    return { ok: false, reason: `Unsupported PID ${command}` };
  }

  const cleaned = normalizeElmResponse(rawOrCleanedResponse, command);

  if (!cleaned) {
    return { ok: false, reason: 'Empty response' };
  }

  if (cleaned.includes('NODATA')) {
    return { ok: false, reason: 'NO DATA' };
  }

  if (!/^[0-9A-F]+$/.test(cleaned)) {
    return { ok: false, reason: `Non-hex response: ${cleaned}` };
  }

  const markerIndex = cleaned.indexOf(definition.marker);

  if (markerIndex < 0) {
    return { ok: false, reason: `Missing marker ${definition.marker}` };
  }

  const payloadStart = markerIndex + definition.marker.length;
  const payloadLength = definition.bytes * 2;
  const payload = cleaned.slice(payloadStart, payloadStart + payloadLength);

  if (payload.length < payloadLength) {
    return { ok: false, reason: `Short payload for ${command}` };
  }

  const bytes = payload.match(/.{1,2}/g)?.map(byte => Number.parseInt(byte, 16));

  if (!bytes || bytes.length !== definition.bytes || bytes.some(Number.isNaN)) {
    return { ok: false, reason: `Malformed payload ${payload}` };
  }

  const value = definition.parse(bytes);

  return {
    ok: true,
    value: {
      pid: definition.command,
      label: definition.label,
      shortLabel: definition.shortLabel,
      unit: definition.unit,
      value,
      displayValue: formatValue(definition, value),
    },
  };
};
