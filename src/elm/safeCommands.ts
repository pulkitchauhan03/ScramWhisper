const SAFE_AT_COMMANDS = new Set([
  'ATZ',
  'ATI',
  'ATE0',
  'ATL0',
  'ATS0',
  'ATH0',
  'ATSP0',
]);

export const isSafeCommand = (command: string) => {
  const normalized = command.toUpperCase().replace(/\s/g, '');

  if (SAFE_AT_COMMANDS.has(normalized)) {
    return true;
  }

  return /^01[0-9A-F]{2}$/.test(normalized);
};
