import type { BluetoothDevice, BluetoothEventSubscription } from 'react-native-bluetooth-classic';
import { normalizeElmResponse } from '../obd/parser';
import { isSafeCommand } from './safeCommands';

export type ElmCommandResult = {
  command: string;
  raw: string;
  cleaned: string;
  durationMs: number;
};

type PendingCommand = {
  command: string;
  startedAt: number;
  buffer: string;
  resolve: (result: ElmCommandResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ReadEvent = {
  data?: string;
};

export class Elm327Client {
  private device: BluetoothDevice | null = null;
  private readSubscription: BluetoothEventSubscription | null = null;
  private pending: PendingCommand | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  attachDevice(device: BluetoothDevice) {
    this.detach();
    this.device = device;
    this.readSubscription = device.onDataReceived((event: ReadEvent) => {
      this.handleIncoming(event.data ?? '');
    });
  }

  detach() {
    this.readSubscription?.remove();
    this.readSubscription = null;

    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(new Error('Bluetooth device detached'));
      this.pending = null;
    }

    this.device = null;
    this.queue = Promise.resolve();
  }

  runSetup(onStep?: (command: string, result: ElmCommandResult) => void) {
    const setupCommands = ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0', '0100'];

    return setupCommands.reduce(
      (chain, command) => chain.then(async () => {
        const result = await this.sendCommand(command, command === 'ATZ' ? 5000 : 3500);
        onStep?.(command, result);
      }),
      Promise.resolve(),
    );
  }

  sendCommand(command: string, timeoutMs = 2500): Promise<ElmCommandResult> {
    const normalizedCommand = command.toUpperCase().replace(/\s/g, '');

    if (!isSafeCommand(normalizedCommand)) {
      return Promise.reject(new Error(`Blocked unsafe command: ${command}`));
    }

    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.execute(normalizedCommand, timeoutMs));

    return this.queue as Promise<ElmCommandResult>;
  }

  private execute(command: string, timeoutMs: number) {
    if (!this.device) {
      return Promise.reject(new Error('No Bluetooth device connected'));
    }

    return new Promise<ElmCommandResult>((resolve, reject) => {
      const startedAt = Date.now();

      const timeout = setTimeout(() => {
        if (this.pending?.command === command) {
          const raw = this.pending.buffer;
          this.pending = null;
          reject(new Error(`Timeout waiting for ${command}. Partial response: ${raw || '<empty>'}`));
        }
      }, timeoutMs);

      this.pending = {
        command,
        startedAt,
        buffer: '',
        resolve,
        reject,
        timeout,
      };

      this.device
        ?.write(`${command}\r`, 'ascii')
        .catch(error => {
          if (this.pending?.command === command) {
            clearTimeout(this.pending.timeout);
            this.pending = null;
          }

          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private handleIncoming(chunk: string) {
    if (!this.pending || !chunk) {
      return;
    }

    this.pending.buffer += chunk;

    if (!this.pending.buffer.includes('>') && chunk.length === 0) {
      return;
    }

    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timeout);

    pending.resolve({
      command: pending.command,
      raw: pending.buffer,
      cleaned: normalizeElmResponse(pending.buffer, pending.command),
      durationMs: Date.now() - pending.startedAt,
    });
  }
}
