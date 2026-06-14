import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import RNBluetoothClassic, {
  type BluetoothDevice,
} from 'react-native-bluetooth-classic';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';
import {
  SafeAreaProvider,
} from 'react-native-safe-area-context';
import { Elm327Client, ElmCommandResult } from './src/elm/Elm327Client';
import { parseObdResponse } from './src/obd/parser';
import {
  DashboardMetric,
  PidDefinition,
  PID_BY_COMMAND,
  initialMetric,
} from './src/obd/pids';
import {
  BIKE_DASHBOARDS,
  DASHBOARD_PIDS,
  DEFAULT_DASHBOARD_ID,
} from './src/obd/dashboards';
import { requestBluetoothPermissions } from './src/bluetooth/permissions';

type Screen = 'dashboard' | 'devices' | 'logs' | 'settings';

type ConnectionState =
  | 'disconnected'
  | 'checking'
  | 'connecting'
  | 'initializing'
  | 'live'
  | 'error';

type AppLog = {
  id: string;
  time: string;
  level: 'info' | 'error' | 'command';
  title: string;
  detail?: string;
};

const POLLING_COMMAND_TIMEOUT_MS = 200;
const POLLING_DASHBOARD_CYCLE_PAUSE_MS = 100;
const COMMAND_LOG_SAMPLE_RATE = 8;
const RPM_MAX = 10000;
const RPM_REDLINE_START = 8000;
const GAUGE_START_ANGLE = 145;
const GAUGE_END_ANGLE = 385;

const metricDefinitions = DASHBOARD_PIDS
  .map(pid => PID_BY_COMMAND.get(pid))
  .filter((definition): definition is PidDefinition => Boolean(definition));

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#101820" />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const elmClient = useRef(new Elm327Client()).current;
  const pollingActive = useRef(false);
  const commandLogCounter = useRef(0);
  const activeDashboardCommands = useRef(BIKE_DASHBOARDS[0].commands);
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [activeDashboardId, setActiveDashboardId] = useState(DEFAULT_DASHBOARD_ID);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<BluetoothDevice | null>(null);
  const [isRefreshingDevices, setIsRefreshingDevices] = useState(false);
  const [logs, setLogs] = useState<AppLog[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, DashboardMetric>>(() => {
    return Object.fromEntries(
      metricDefinitions.map(definition => [
        definition.command,
        initialMetric(definition),
      ]),
    );
  });

  const isBusy = connectionState === 'checking' ||
    connectionState === 'connecting' ||
    connectionState === 'initializing';

  const activeDashboard = useMemo(() => {
    return BIKE_DASHBOARDS.find(dashboard => dashboard.id === activeDashboardId) ??
      BIKE_DASHBOARDS[0];
  }, [activeDashboardId]);
  const isRideHud = screen === 'dashboard' && activeDashboard.id === 'ride';
  const adapterLabel = selectedDevice
    ? `${selectedDevice.name || 'Unnamed adapter'} / ${selectedDevice.address}`
    : 'No adapter selected';

  const addLog = useCallback((log: Omit<AppLog, 'id' | 'time'>) => {
    const now = new Date();

    setLogs(previous => [
      {
        ...log,
        id: `${now.getTime()}-${Math.random().toString(16).slice(2)}`,
        time: now.toLocaleTimeString(),
      },
      ...previous,
    ].slice(0, 300));
  }, []);

  const refreshDevices = useCallback(async () => {
    setConnectionState(state => state === 'disconnected' ? 'checking' : state);
    setIsRefreshingDevices(true);
    setLastError(null);

    try {
      const granted = await requestBluetoothPermissions();

      if (!granted) {
        throw new Error('Bluetooth permission was not granted');
      }

      const available = await RNBluetoothClassic.isBluetoothAvailable();

      if (!available) {
        throw new Error('Bluetooth is not available on this device');
      }

      const enabled = await RNBluetoothClassic.isBluetoothEnabled();

      if (!enabled) {
        await RNBluetoothClassic.requestBluetoothEnabled();
      }

      const bondedDevices = await RNBluetoothClassic.getBondedDevices();
      setDevices(bondedDevices);
      addLog({
        level: 'info',
        title: 'Paired devices loaded',
        detail: `${bondedDevices.length} Bluetooth Classic device(s) found`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      setConnectionState('error');
      addLog({ level: 'error', title: 'Bluetooth check failed', detail: message });
    } finally {
      setIsRefreshingDevices(false);
      setConnectionState(state => state === 'checking' ? 'disconnected' : state);
    }
  }, [addLog]);

  const logCommand = useCallback((result: ElmCommandResult) => {
    addLog({
      level: 'command',
      title: `${result.command} completed in ${result.durationMs} ms`,
      detail: `Raw: ${result.raw}\nClean: ${result.cleaned || '<empty>'}`,
    });
  }, [addLog]);

  const updateMetricFromResult = useCallback((command: string, result: ElmCommandResult) => {
    const parsed = parseObdResponse(command, result.cleaned);

    if (!parsed.ok) {
      setMetrics(previous => ({
        ...previous,
        [command]: {
          ...previous[command],
          status: parsed.reason === 'NO DATA' ? 'no-data' : 'parse-error',
          raw: result.raw,
        },
      }));
      addLog({
        level: parsed.reason === 'NO DATA' ? 'info' : 'error',
        title: `${command} parse failed`,
        detail: parsed.reason,
      });
      return;
    }

    setMetrics(previous => ({
      ...previous,
      [command]: {
        ...previous[command],
        value: parsed.value.value,
        displayValue: parsed.value.displayValue,
        status: 'fresh',
        updatedAt: Date.now(),
        raw: result.raw,
      },
    }));
  }, [addLog]);

  const startPolling = useCallback(() => {
    if (pollingActive.current) {
      return;
    }

    pollingActive.current = true;

    const poll = async () => {
      while (pollingActive.current) {
        const commands = activeDashboardCommands.current;

        for (const command of commands) {
          if (!pollingActive.current) {
            break;
          }

          try {
            const result = await elmClient.sendCommand(command, POLLING_COMMAND_TIMEOUT_MS);
            commandLogCounter.current += 1;

            if (commandLogCounter.current % COMMAND_LOG_SAMPLE_RATE === 0) {
              logCommand(result);
            }

            updateMetricFromResult(command, result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            addLog({ level: 'error', title: `${command} failed`, detail: message });
          }
        }

        if (POLLING_DASHBOARD_CYCLE_PAUSE_MS > 0) {
          await delay(POLLING_DASHBOARD_CYCLE_PAUSE_MS);
        }
      }
    };

    poll().catch(error => {
      addLog({
        level: 'error',
        title: 'Polling stopped',
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }, [addLog, elmClient, logCommand, updateMetricFromResult]);

  const stopPolling = useCallback(() => {
    pollingActive.current = false;
  }, []);

  const connectToDevice = useCallback(async (device: BluetoothDevice) => {
    if (isBusy) {
      return;
    }

    stopPolling();
    setConnectionState('connecting');
    setLastError(null);
    setSelectedDevice(device);
    addLog({
      level: 'info',
      title: 'Connecting',
      detail: `${device.name || 'Unnamed device'} (${device.address})`,
    });

    try {
      const connectedDevice = await RNBluetoothClassic.connectToDevice(device.address, {
        delimiter: '>',
        charset: 'ascii',
        readSize: 1024,
      });

      elmClient.attachDevice(connectedDevice);
      setConnectionState('initializing');
      addLog({ level: 'info', title: 'ELM327 setup started' });

      await elmClient.runSetup((_, result) => logCommand(result));

      setConnectionState('live');
      addLog({
        level: 'info',
        title: 'Dashboard polling started',
        detail: `Active dashboard: ${activeDashboard.label} (${activeDashboard.commands.join(', ')}), ${POLLING_DASHBOARD_CYCLE_PAUSE_MS} ms cycle pause`,
      });
      startPolling();
      setScreen('dashboard');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      setConnectionState('error');
      addLog({ level: 'error', title: 'Connection failed', detail: message });
      elmClient.detach();
    }
  }, [activeDashboard, addLog, elmClient, isBusy, logCommand, startPolling, stopPolling]);

  const disconnect = useCallback(async () => {
    stopPolling();

    try {
      if (selectedDevice) {
        await RNBluetoothClassic.disconnectFromDevice(selectedDevice.address);
      }
    } catch (error) {
      addLog({
        level: 'error',
        title: 'Disconnect failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      elmClient.detach();
      setConnectionState('disconnected');
      addLog({ level: 'info', title: 'Disconnected' });
    }
  }, [addLog, elmClient, selectedDevice, stopPolling]);

  useEffect(() => {
    refreshDevices().catch(error => {
      addLog({
        level: 'error',
        title: 'Initial Bluetooth refresh failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    });

    return () => {
      stopPolling();
      elmClient.detach();
    };
  }, [addLog, elmClient, refreshDevices, stopPolling]);

  useEffect(() => {
    activeDashboardCommands.current = activeDashboard.commands;
    addLog({
      level: 'info',
      title: 'Dashboard changed',
      detail: `${activeDashboard.label}: ${activeDashboard.commands.join(', ')}`,
    });
  }, [activeDashboard, addLog]);

  const staleMetrics = useMemo(() => {
    const now = Date.now();

    return Object.fromEntries(
      Object.entries(metrics).map(([pid, metric]) => {
        if (metric.status === 'fresh' && metric.updatedAt && now - metric.updatedAt > 5000) {
          return [pid, { ...metric, status: 'stale' }];
        }

        return [pid, metric];
      }),
    ) as Record<string, DashboardMetric>;
  }, [metrics]);

  return (
    <SafeAreaView style={[styles.container, isRideHud ? styles.rideContainer : null]}>
      {!isRideHud ? (
        <>
          <View style={styles.header}>
            <View>
              <Text style={styles.appName}>ScramWhisper</Text>
              <Text style={styles.subtitle}>Triumph Scrambler 400X ECU</Text>
            </View>
            <StatusPill state={connectionState} />
          </View>

          <View style={styles.connectionPanel}>
            <View>
              <Text style={styles.panelLabel}>Adapter</Text>
              <Text style={styles.deviceName}>
                {selectedDevice?.name || 'No adapter selected'}
              </Text>
              <Text style={styles.deviceAddress}>
                {selectedDevice?.address || 'Pair your ELM327 in Android settings first'}
              </Text>
            </View>
            {connectionState === 'live' ? (
              <Pressable style={styles.secondaryButton} onPress={disconnect}>
                <Text style={styles.secondaryButtonText}>Disconnect</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      ) : null}

      {lastError ? <Text style={styles.errorBanner}>{lastError}</Text> : null}

      <View style={styles.content}>
        {screen === 'dashboard' ? (
          <DashboardScreen
            activeDashboard={activeDashboard}
            dashboards={BIKE_DASHBOARDS}
            metricsByCommand={staleMetrics}
            metrics={activeDashboard.commands
              .map(command => staleMetrics[command])
              .filter((metric): metric is DashboardMetric => Boolean(metric))}
            isBusy={isBusy}
            connectionState={connectionState}
            adapterLabel={adapterLabel}
            onDashboardChange={setActiveDashboardId}
          />
        ) : null}
        {screen === 'devices' ? (
          <DevicesScreen
            devices={devices}
            isRefreshing={isRefreshingDevices}
            isBusy={isBusy}
            onRefresh={refreshDevices}
            onConnect={connectToDevice}
          />
        ) : null}
        {screen === 'logs' ? <LogsScreen logs={logs} onClear={() => setLogs([])} /> : null}
        {screen === 'settings' ? (
          <SettingsScreen
            connectionState={connectionState}
            selectedDevice={selectedDevice}
          />
        ) : null}
      </View>

      <View style={styles.tabs}>
        <TabButton label="Dash" active={screen === 'dashboard'} onPress={() => setScreen('dashboard')} />
        <TabButton label="Devices" active={screen === 'devices'} onPress={() => setScreen('devices')} />
        <TabButton label="Logs" active={screen === 'logs'} onPress={() => setScreen('logs')} />
        <TabButton label="Settings" active={screen === 'settings'} onPress={() => setScreen('settings')} />
      </View>
    </SafeAreaView>
  );
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const clamp = (value: number, min: number, max: number) => {
  return Math.min(Math.max(value, min), max);
};

const gaugeAngleForRpm = (rpm: number) => {
  const normalized = clamp(rpm, 0, RPM_MAX) / RPM_MAX;
  return GAUGE_START_ANGLE + ((GAUGE_END_ANGLE - GAUGE_START_ANGLE) * normalized);
};

const polarToCartesian = (
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number,
) => {
  const angleInRadians = (angleInDegrees - 90) * Math.PI / 180;

  return {
    x: centerX + (radius * Math.cos(angleInRadians)),
    y: centerY + (radius * Math.sin(angleInRadians)),
  };
};

const describeArc = (
  x: number,
  y: number,
  radius: number,
  startAngle: number,
  endAngle: number,
) => {
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return [
    'M',
    start.x,
    start.y,
    'A',
    radius,
    radius,
    0,
    largeArcFlag,
    0,
    end.x,
    end.y,
  ].join(' ');
};

function StatusPill({ state }: { state: ConnectionState }) {
  return (
    <View style={[styles.statusPill, state === 'live' ? styles.statusLive : null]}>
      <Text style={styles.statusText}>{state.toUpperCase()}</Text>
    </View>
  );
}

function DashboardScreen({
  activeDashboard,
  dashboards,
  metricsByCommand,
  metrics,
  isBusy,
  connectionState,
  adapterLabel,
  onDashboardChange,
}: {
  activeDashboard: typeof BIKE_DASHBOARDS[number];
  dashboards: typeof BIKE_DASHBOARDS;
  metricsByCommand: Record<string, DashboardMetric>;
  metrics: DashboardMetric[];
  isBusy: boolean;
  connectionState: ConnectionState;
  adapterLabel: string;
  onDashboardChange: (dashboardId: string) => void;
}) {
  if (activeDashboard.id === 'ride') {
    return (
      <View style={styles.rideHudScreen}>
        <View style={styles.rideTopOverlay}>
          <View style={styles.rideStatusStrip}>
            <View style={[
              styles.rideStatusDot,
              connectionState === 'live' ? styles.rideStatusDotLive : null,
            ]} />
            <Text style={styles.rideStatusText}>{connectionState.toUpperCase()}</Text>
            <Text style={styles.rideAdapterText} numberOfLines={1}>{adapterLabel}</Text>
          </View>
          <DashboardSwitcher
            dashboards={dashboards}
            activeDashboard={activeDashboard}
            onDashboardChange={onDashboardChange}
            compact
          />
        </View>
        {isBusy ? (
          <View style={styles.rideBusyRow}>
            <ActivityIndicator color="#6EE7B7" />
            <Text style={styles.busyText}>Preparing adapter</Text>
          </View>
        ) : null}
        <SpeedometerHud
          speedMetric={metricsByCommand['010D']}
          rpmMetric={metricsByCommand['010C']}
          connectionState={connectionState}
          adapterLabel={adapterLabel}
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.dashboardGrid}>
      <DashboardSwitcher
        dashboards={dashboards}
        activeDashboard={activeDashboard}
        onDashboardChange={onDashboardChange}
      />
      {isBusy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator color="#6EE7B7" />
          <Text style={styles.busyText}>Preparing adapter</Text>
        </View>
      ) : null}
      {metrics.map(metric => (
        <MetricTile key={metric.pid} metric={metric} />
      ))}
    </ScrollView>
  );
}

function DashboardSwitcher({
  dashboards,
  activeDashboard,
  compact = false,
  onDashboardChange,
}: {
  dashboards: typeof BIKE_DASHBOARDS;
  activeDashboard: typeof BIKE_DASHBOARDS[number];
  compact?: boolean;
  onDashboardChange: (dashboardId: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[
        styles.dashboardSwitcher,
        compact ? styles.compactDashboardSwitcher : null,
      ]}>
      {dashboards.map(dashboard => (
        <Pressable
          key={dashboard.id}
          style={[
            styles.dashboardChip,
            compact ? styles.compactDashboardChip : null,
            dashboard.id === activeDashboard.id ? styles.activeDashboardChip : null,
            compact && dashboard.id === activeDashboard.id ? styles.activeCompactDashboardChip : null,
          ]}
          onPress={() => onDashboardChange(dashboard.id)}>
          <Text
            style={[
              styles.dashboardChipText,
              compact ? styles.compactDashboardChipText : null,
              dashboard.id === activeDashboard.id ? styles.activeDashboardChipText : null,
            ]}>
            {dashboard.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function SpeedometerHud({
  speedMetric,
  rpmMetric,
}: {
  speedMetric?: DashboardMetric;
  rpmMetric?: DashboardMetric;
  connectionState: ConnectionState;
  adapterLabel: string;
}) {
  const speedIsFresh = speedMetric?.status === 'fresh' && speedMetric.value !== null;
  const rpmIsFresh = rpmMetric?.status === 'fresh' && rpmMetric.value !== null;
  const speedValue = speedIsFresh ? String(Math.round(speedMetric.value ?? 0)) : '--';
  const rpmValue = rpmIsFresh ? clamp(rpmMetric.value ?? 0, 0, RPM_MAX) : 0;
  const rpmLabel = rpmIsFresh ? `${Math.round(rpmValue / 100) / 10}k rpm` : '-- rpm';
  const activeEndAngle = gaugeAngleForRpm(rpmValue);
  const dimmed = !speedIsFresh || !rpmIsFresh;
  const tickAngles = Array.from({ length: 11 }, (_, index) => gaugeAngleForRpm(index * 1000));
  const redlineStartAngle = gaugeAngleForRpm(RPM_REDLINE_START);

  return (
    <View style={[styles.speedometerHud, dimmed ? styles.speedometerHudDimmed : null]}>
      <Svg width="100%" height="100%" viewBox="0 0 320 320">
        <Circle cx="160" cy="160" r="117" stroke="#101923" strokeWidth="18" fill="none" />
        <Path
          d={describeArc(160, 160, 116, GAUGE_START_ANGLE, GAUGE_END_ANGLE)}
          stroke="#33404C"
          strokeWidth="14"
          strokeLinecap="round"
          fill="none"
        />
        <Path
          d={describeArc(160, 160, 116, redlineStartAngle, GAUGE_END_ANGLE)}
          stroke="#E54B35"
          strokeWidth="14"
          strokeLinecap="round"
          fill="none"
          opacity={0.9}
        />
        {rpmIsFresh && rpmValue > 0 ? (
          <Path
            d={describeArc(160, 160, 116, GAUGE_START_ANGLE, activeEndAngle)}
            stroke={rpmValue >= RPM_REDLINE_START ? '#FF765C' : '#F5F7FA'}
            strokeWidth="9"
            strokeLinecap="round"
            fill="none"
          />
        ) : null}
        <G>
          {tickAngles.map((angle, index) => {
            const inner = polarToCartesian(160, 160, index % 2 === 0 ? 96 : 101, angle);
            const outer = polarToCartesian(160, 160, 126, angle);
            const label = polarToCartesian(160, 160, 82, angle);

            return (
              <G key={angle}>
                <Line
                  x1={inner.x}
                  y1={inner.y}
                  x2={outer.x}
                  y2={outer.y}
                  stroke={index >= 8 ? '#FF765C' : '#DDE4EC'}
                  strokeWidth={index % 2 === 0 ? 2.4 : 1.4}
                  strokeLinecap="round"
                  opacity={index >= 8 ? 0.95 : 0.78}
                />
                {index % 2 === 0 ? (
                  <SvgText
                    x={label.x}
                    y={label.y + 4}
                    fill={index >= 8 ? '#FF9A85' : '#94A3B8'}
                    fontSize="11"
                    fontWeight="700"
                    textAnchor="middle">
                    {index}
                  </SvgText>
                ) : null}
              </G>
            );
          })}
        </G>
      </Svg>
      <View style={styles.speedReadout}>
        <Text style={[styles.speedValue, !speedIsFresh ? styles.mutedValue : null]}>
          {speedValue}
        </Text>
        <Text style={styles.speedUnit}>km/h</Text>
        <Text style={[styles.rpmReadout, !rpmIsFresh ? styles.metricStatusMuted : null]}>
          {rpmLabel}
        </Text>
      </View>
    </View>
  );
}

function MetricTile({ metric }: { metric: DashboardMetric }) {
  const muted = metric.status !== 'fresh';

  return (
    <View style={styles.metricTile}>
      <View style={styles.metricHeader}>
        <Text style={styles.metricLabel}>{metric.shortLabel}</Text>
        <Text style={[styles.metricStatus, muted ? styles.metricStatusMuted : null]}>
          {metric.status}
        </Text>
      </View>
      <Text style={[styles.metricValue, muted ? styles.mutedValue : null]}>
        {metric.displayValue}
      </Text>
      <Text style={styles.metricUnit}>{metric.unit}</Text>
    </View>
  );
}

function DevicesScreen({
  devices,
  isRefreshing,
  isBusy,
  onRefresh,
  onConnect,
}: {
  devices: BluetoothDevice[];
  isRefreshing: boolean;
  isBusy: boolean;
  onRefresh: () => void;
  onConnect: (device: BluetoothDevice) => void;
}) {
  return (
    <View style={styles.screenBlock}>
      <View style={styles.screenHeader}>
        <Text style={styles.screenTitle}>Paired Bluetooth Devices</Text>
        <Pressable style={styles.secondaryButton} onPress={onRefresh} disabled={isRefreshing}>
          <Text style={styles.secondaryButtonText}>
            {isRefreshing ? 'Loading' : 'Refresh'}
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={devices}
        keyExtractor={item => item.address}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No paired Bluetooth Classic devices found.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.deviceRow}>
            <View style={styles.deviceInfo}>
              <Text style={styles.deviceRowName}>{item.name || 'Unnamed device'}</Text>
              <Text style={styles.deviceAddress}>{item.address}</Text>
              <Text style={styles.deviceAddress}>{item.type}</Text>
            </View>
            <Pressable
              style={[styles.primaryButton, isBusy ? styles.disabledButton : null]}
              onPress={() => onConnect(item)}
              disabled={isBusy}>
              <Text style={styles.primaryButtonText}>Connect</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

function LogsScreen({
  logs,
  onClear,
}: {
  logs: AppLog[];
  onClear: () => void;
}) {
  return (
    <View style={styles.screenBlock}>
      <View style={styles.screenHeader}>
        <Text style={styles.screenTitle}>Raw Logs</Text>
        <Pressable style={styles.secondaryButton} onPress={onClear}>
          <Text style={styles.secondaryButtonText}>Clear</Text>
        </Pressable>
      </View>
      <FlatList
        data={logs}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={<Text style={styles.emptyText}>No logs yet.</Text>}
        renderItem={({ item }) => (
          <View style={styles.logRow}>
            <View style={styles.logTopLine}>
              <Text style={[
                styles.logLevel,
                item.level === 'error' ? styles.logLevelError : null,
                item.level === 'command' ? styles.logLevelCommand : null,
              ]}>
                {item.level}
              </Text>
              <Text style={styles.logTime}>{item.time}</Text>
            </View>
            <Text style={styles.logTitle}>{item.title}</Text>
            {item.detail ? <Text style={styles.logDetail}>{item.detail}</Text> : null}
          </View>
        )}
      />
    </View>
  );
}

function SettingsScreen({
  connectionState,
  selectedDevice,
}: {
  connectionState: ConnectionState;
  selectedDevice: BluetoothDevice | null;
}) {
  return (
    <ScrollView contentContainerStyle={styles.settingsContent}>
      <SettingRow label="Bike" value="Triumph Scrambler 400X" />
      <SettingRow label="Mode" value="Read-only Mode 01 polling" />
      <SettingRow label="Polling" value="Only active dashboard, max 4 PIDs" />
      <SettingRow label="Connection" value={connectionState} />
      <SettingRow label="Selected adapter" value={selectedDevice?.name || 'None'} />
      <SettingRow label="Blocked commands" value="Mode 04 and non-whitelisted writes" />
    </ScrollView>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.settingValue}>{value}</Text>
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.tabButton, active ? styles.activeTab : null]} onPress={onPress}>
      <Text style={[styles.tabText, active ? styles.activeTabText : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#101820',
  },
  rideContainer: {
    backgroundColor: '#080D12',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  appName: {
    color: '#F8FAFC',
    fontSize: 26,
    fontWeight: '800',
  },
  subtitle: {
    color: '#94A3B8',
    marginTop: 2,
  },
  statusPill: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#475569',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#1E293B',
  },
  statusLive: {
    borderColor: '#34D399',
    backgroundColor: '#064E3B',
  },
  statusText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '800',
  },
  connectionPanel: {
    marginHorizontal: 20,
    marginBottom: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#263241',
    backgroundColor: '#162231',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  panelLabel: {
    color: '#6EE7B7',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  deviceName: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 4,
  },
  deviceAddress: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 2,
  },
  errorBanner: {
    marginHorizontal: 20,
    marginBottom: 10,
    color: '#FCA5A5',
    backgroundColor: '#3F1D24',
    borderColor: '#7F1D1D',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  content: {
    flex: 1,
  },
  rideHudScreen: {
    flex: 1,
    backgroundColor: '#080D12',
    paddingHorizontal: 14,
    paddingBottom: 6,
    justifyContent: 'center',
  },
  rideTopOverlay: {
    position: 'absolute',
    top: 10,
    left: 14,
    right: 14,
    zIndex: 2,
    gap: 8,
  },
  rideStatusStrip: {
    minHeight: 34,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#22303C',
    backgroundColor: 'rgba(13, 21, 29, 0.78)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    gap: 8,
  },
  rideStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#64748B',
  },
  rideStatusDotLive: {
    backgroundColor: '#34D399',
  },
  rideStatusText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '900',
  },
  rideAdapterText: {
    flex: 1,
    color: '#94A3B8',
    fontSize: 11,
    textAlign: 'right',
  },
  rideBusyRow: {
    position: 'absolute',
    top: 106,
    left: 20,
    right: 20,
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  dashboardGrid: {
    paddingHorizontal: 16,
    paddingBottom: 18,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  dashboardSwitcher: {
    width: '100%',
    paddingHorizontal: 4,
    paddingBottom: 8,
    gap: 8,
  },
  compactDashboardSwitcher: {
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  dashboardChip: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: '#111827',
  },
  compactDashboardChip: {
    backgroundColor: 'rgba(14, 22, 30, 0.72)',
    borderColor: '#22303C',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  activeDashboardChip: {
    borderColor: '#2DD4BF',
    backgroundColor: '#143A3A',
  },
  activeCompactDashboardChip: {
    backgroundColor: 'rgba(24, 63, 61, 0.82)',
  },
  dashboardChipText: {
    color: '#94A3B8',
    fontWeight: '800',
    fontSize: 12,
  },
  compactDashboardChipText: {
    fontSize: 11,
  },
  activeDashboardChipText: {
    color: '#E6FFFA',
  },
  busyRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  busyText: {
    color: '#CBD5E1',
  },
  metricTile: {
    width: '48%',
    minHeight: 138,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#263241',
    backgroundColor: '#172433',
    padding: 14,
    justifyContent: 'space-between',
  },
  metricHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  metricLabel: {
    color: '#CBD5E1',
    fontSize: 13,
    fontWeight: '800',
  },
  metricStatus: {
    color: '#6EE7B7',
    fontSize: 10,
    textTransform: 'uppercase',
  },
  metricStatusMuted: {
    color: '#64748B',
  },
  metricValue: {
    color: '#F8FAFC',
    fontSize: 36,
    fontWeight: '900',
    marginTop: 10,
  },
  mutedValue: {
    color: '#64748B',
  },
  mutedValueLarge: {
    color: '#64748B',
    fontSize: 36,
    fontWeight: '900',
    marginTop: 10,
  },
  speedometerHud: {
    width: '100%',
    maxWidth: 410,
    aspectRatio: 1,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 36,
  },
  speedometerHudDimmed: {
    opacity: 0.62,
  },
  speedReadout: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    top: '32%',
    left: 0,
    right: 0,
  },
  speedValue: {
    color: '#F8FAFC',
    fontSize: 92,
    lineHeight: 102,
    fontWeight: '900',
  },
  speedUnit: {
    color: '#CBD5E1',
    fontSize: 16,
    fontWeight: '800',
    textTransform: 'uppercase',
    marginTop: -4,
  },
  rpmReadout: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '800',
    marginTop: 12,
  },
  metricUnit: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '700',
  },
  screenBlock: {
    flex: 1,
    paddingHorizontal: 20,
  },
  screenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  screenTitle: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '800',
  },
  listContent: {
    paddingBottom: 24,
  },
  emptyText: {
    color: '#94A3B8',
    paddingTop: 24,
    textAlign: 'center',
  },
  deviceRow: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#263241',
    backgroundColor: '#172433',
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceRowName: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '800',
  },
  primaryButton: {
    borderRadius: 6,
    backgroundColor: '#2DD4BF',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primaryButtonText: {
    color: '#042F2E',
    fontWeight: '900',
  },
  secondaryButton: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  secondaryButtonText: {
    color: '#E2E8F0',
    fontWeight: '800',
  },
  disabledButton: {
    opacity: 0.5,
  },
  logRow: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#263241',
    backgroundColor: '#172433',
    padding: 12,
    marginBottom: 10,
  },
  logTopLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  logLevel: {
    color: '#93C5FD',
    fontSize: 11,
    textTransform: 'uppercase',
    fontWeight: '900',
  },
  logLevelError: {
    color: '#FCA5A5',
  },
  logLevelCommand: {
    color: '#6EE7B7',
  },
  logTime: {
    color: '#64748B',
    fontSize: 11,
  },
  logTitle: {
    color: '#F8FAFC',
    fontWeight: '800',
  },
  logDetail: {
    color: '#CBD5E1',
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
  },
  settingsContent: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  settingRow: {
    borderBottomWidth: 1,
    borderBottomColor: '#263241',
    paddingVertical: 14,
  },
  settingLabel: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  settingValue: {
    color: '#F8FAFC',
    fontSize: 16,
    marginTop: 6,
  },
  tabs: {
    borderTopWidth: 1,
    borderTopColor: '#263241',
    backgroundColor: '#0F172A',
    flexDirection: 'row',
    padding: 8,
    gap: 6,
  },
  tabButton: {
    flex: 1,
    borderRadius: 6,
    alignItems: 'center',
    paddingVertical: 10,
  },
  activeTab: {
    backgroundColor: '#1E293B',
  },
  tabText: {
    color: '#94A3B8',
    fontWeight: '800',
    fontSize: 12,
  },
  activeTabText: {
    color: '#F8FAFC',
  },
});

export default App;
