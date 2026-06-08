export type ShellPlatform = "win32" | "posix";

export function normalizeShellCommand(command: string, platform: ShellPlatform = "posix"): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  return platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

export function hasShellControlOperator(command: string): boolean {
  return findFirstControlOperator(command) !== null;
}

export function firstShellCommandSegment(command: string): string {
  const op = findFirstControlOperator(command);
  return (op ? command.slice(0, op.index) : command).trim();
}

export function suggestShellPrefix(command: string): string {
  return firstShellCommandSegment(command);
}

export function shellPrefixMatches(
  command: string,
  prefix: string,
  platform: ShellPlatform = "posix",
): boolean {
  const trimmedPrefix = prefix.trim();
  if (!trimmedPrefix) return false;

  const prefixHasControl = hasShellControlOperator(trimmedPrefix);
  const commandHasControl = hasShellControlOperator(command);
  const comparableCommand = normalizeShellCommand(command, platform);
  const comparablePrefix = normalizeShellCommand(trimmedPrefix, platform);

  if (!comparableCommand.startsWith(comparablePrefix)) return false;
  const boundary = comparableCommand.charAt(comparablePrefix.length);
  if (boundary && !/\s/.test(boundary)) return false;

  if (prefixHasControl) return true;
  if (commandHasControl) return false;

  const commandSegment = normalizeShellCommand(firstShellCommandSegment(command), platform);
  return commandSegment === comparablePrefix || commandSegment.startsWith(`${comparablePrefix} `);
}

function findFirstControlOperator(command: string): { index: number; operator: string } | null {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      return { index: i, operator: two };
    }
    if (char === "|" || char === ";") {
      return { index: i, operator: char };
    }
  }

  return null;
}
