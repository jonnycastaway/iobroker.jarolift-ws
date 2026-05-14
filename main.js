'use strict';

const utils = require('@iobroker/adapter-core');
const WebSocket = require('ws');

const RECONNECT_INTERVAL = 10000; // ms
const ELEMENT_CHANNEL = 'p01';
const ELEMENT_GROUP = 'p02';

class JaroliftAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'jarolift-ws' });

        this._ws = null;
        this._reconnectTimer = null;
        this._connected = false;

        this.on('ready', this._onReady.bind(this));
        this.on('stateChange', this._onStateChange.bind(this));
        this.on('unload', this._onUnload.bind(this));
    }

    // ─────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────

    async _onReady() {
        this.log.info(`Jarolift Adapter gestartet – verbinde mit ${this.config.host}`);

        await this._createObjects();
        this._connectWebSocket();
    }

    _onUnload(callback) {
        this._stopReconnect();
        if (this._ws) {
            this._ws.terminate();
            this._ws = null;
        }
        this._setConnected(false);
        callback();
    }

    // ─────────────────────────────────────────────
    // Object creation
    // ─────────────────────────────────────────────

    async _cleanupObjects(kind, keepCount) {
        // Delete channel/group indices that exceed the configured count
        for (let i = keepCount; i < 16; i++) {
            const base = `${kind}.${i}`;
            const obj = await this.getObjectAsync(base);
            if (!obj) break; // no more objects exist beyond this index
            this.log.info(`Entferne überzähligen Eintrag: ${base}`);
            for (const state of ['up', 'down', 'stop', 'shade', 'command', 'lastCommand']) {
                await this.delObjectAsync(`${base}.${state}`);
            }
            await this.delObjectAsync(base);
        }
    }

    async _createObjects() {
        const numChannels = this.config.num_channels || 4;
        const numGroups   = this.config.num_groups   || 0;

        // ── Cleanup excess objects from previous config ──
        await this._cleanupObjects('channels', numChannels);
        await this._cleanupObjects('groups', numGroups);

        // ── Channels ──
        await this.setObjectNotExistsAsync('channels', {
            type: 'channel',
            common: { name: 'Kanäle' },
            native: {},
        });

        for (let i = 0; i < numChannels; i++) {
            const name = this.config[`channel_${i}`] || `Kanal ${i + 1}`;
            const base = `channels.${i}`;

            await this.setObjectNotExistsAsync(base, {
                type: 'channel',
                common: { name },
                native: {},
            });

            await this._createShutterStates(base, name);
        }

        // ── Groups ──
        if (numGroups > 0) {
            await this.setObjectNotExistsAsync('groups', {
                type: 'channel',
                common: { name: 'Gruppen' },
                native: {},
            });

            for (let i = 0; i < numGroups; i++) {
                const name = this.config[`group_${i}`] || `Gruppe ${i + 1}`;
                const base = `groups.${i}`;

                await this.setObjectNotExistsAsync(base, {
                    type: 'channel',
                    common: { name },
                    native: {},
                });

                await this._createShutterStates(base, name);
            }
        }

        // ── Info ──
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: {
                name: 'WebSocket verbunden',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });

        // ── Controller status ──
        await this.setObjectNotExistsAsync('info.ip', {
            type: 'state',
            common: { name: 'IP-Adresse', type: 'string', role: 'info.ip', read: true, write: false, def: '' },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.uptime', {
            type: 'state',
            common: { name: 'Uptime', type: 'string', role: 'info.uptime', read: true, write: false, def: '' },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.mqtt_status', {
            type: 'state',
            common: { name: 'MQTT Status', type: 'string', role: 'text', read: true, write: false, def: '' },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.wifi_signal', {
            type: 'state',
            common: { name: 'WLAN Signal', type: 'string', role: 'value', read: true, write: false, def: '' },
            native: {},
        });

        this.log.debug('Alle Objekte angelegt');
    }

    async _createShutterStates(base, name) {
        // Command state (up / down / stop / shade) – string selector
        await this.setObjectAsync(`${base}.command`, {
            type: 'state',
            common: {
                name: `${name} – Befehl`,
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                states: {
                    up:    'Hoch',
                    down:  'Runter',
                    stop:  'Stop',
                    shade: 'Schattenstellung',
                },
            },
            native: {},
        });

        // Button states – role "button" tells ioBroker UI to render as button
        for (const [action, label] of [
            ['up',    'Hoch'],
            ['down',  'Runter'],
            ['stop',  'Stop'],
            ['shade', 'Schattenstellung'],
        ]) {
            await this.setObjectAsync(`${base}.${action}`, {
                type: 'state',
                common: {
                    name: `${name} – ${label}`,
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                },
                native: {},
            });
        }

        // Last command (read-only)
        await this.setObjectAsync(`${base}.lastCommand`, {
            type: 'state',
            common: {
                name: `${name} – Letzter Befehl`,
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });

        this.subscribeStates(`${base}.command`);
        this.subscribeStates(`${base}.up`);
        this.subscribeStates(`${base}.down`);
        this.subscribeStates(`${base}.stop`);
        this.subscribeStates(`${base}.shade`);
    }

    // ─────────────────────────────────────────────
    // State changes → WebSocket commands
    // ─────────────────────────────────────────────

    async _onStateChange(id, state) {
        if (!state || state.ack) return;

        // e.g. "jarolift.0.channels.2.up"  or  "jarolift.0.groups.1.command"
        const parts = id.split('.');
        // parts: [adapter, instance, kind, index, stateKey]
        const kind     = parts[2]; // 'channels' or 'groups'
        const index    = parseInt(parts[3], 10);
        const stateKey = parts[4]; // 'up' / 'down' / 'stop' / 'shade' / 'command'

        if (isNaN(index)) return;
        if (kind !== 'channels' && kind !== 'groups') return;

        const isGroup = kind === 'groups';
        let action = stateKey === 'command' ? state.val : stateKey;

        const validActions = ['up', 'down', 'stop', 'shade'];
        if (!validActions.includes(action)) {
            this.log.warn(`Ungültige Aktion: ${action}`);
            return;
        }

        this.log.info(`Sende: ${kind} ${index} → ${action}`);
        await this._sendCommand(isGroup, index, action);

        const base = `${kind}.${index}`;

        // Reset button state back to false (ack) so it's pressable again
        if (stateKey !== 'command') {
            await this.setStateAsync(`${base}.${stateKey}`, { val: false, ack: true });
        }

        // Update lastCommand
        await this.setStateAsync(`${base}.lastCommand`, { val: action, ack: true });
    }

    // ─────────────────────────────────────────────
    // WebSocket
    // ─────────────────────────────────────────────

    _connectWebSocket() {
        const uri = `ws://${this.config.host}/ws`;
        this.log.info(`Verbinde WebSocket: ${uri}`);

        this._ws = new WebSocket(uri);

        this._ws.on('open', () => {
            this.log.info('WebSocket verbunden');
            this._setConnected(true);
            this._stopReconnect();
        });

        this._ws.on('message', (data) => {
            this._handleMessage(data.toString());
        });

        this._ws.on('close', () => {
            this.log.warn('WebSocket getrennt – reconnect in 10s');
            this._setConnected(false);
            this._scheduleReconnect();
        });

        this._ws.on('error', (err) => {
            this.log.error(`WebSocket Fehler: ${err.message}`);
            this._setConnected(false);
        });
    }

    _handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        if (msg.type === 'updateJSON') {
            if (msg.p09_wifi_ip)       this.setStateAsync('info.ip',          { val: msg.p09_wifi_ip,       ack: true });
            if (msg.p09_uptime)        this.setStateAsync('info.uptime',       { val: msg.p09_uptime,        ack: true });
            if (msg.p09_mqtt_status)   this.setStateAsync('info.mqtt_status',  { val: msg.p09_mqtt_status,   ack: true });
            if (msg.p09_wifi_signal)   this.setStateAsync('info.wifi_signal',  { val: msg.p09_wifi_signal,   ack: true });
        }
    }

    async _sendCommand(isGroup, index, action) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
            this.log.warn('WebSocket nicht verbunden – Befehl verworfen');
            return;
        }

        const prefix = isGroup ? ELEMENT_GROUP : ELEMENT_CHANNEL;
        const msg = {
            type: 'sendData',
            elementId: `${prefix}_${action}_${index}`,
            value: 'true',
        };

        this._ws.send(JSON.stringify(msg), (err) => {
            if (err) this.log.error(`Sendefehler: ${err.message}`);
            else     this.log.debug(`Gesendet: ${JSON.stringify(msg)}`);
        });
    }

    _setConnected(val) {
        this._connected = val;
        this.setStateAsync('info.connection', { val, ack: true });
    }

    _scheduleReconnect() {
        this._stopReconnect();
        this._reconnectTimer = setTimeout(() => {
            this.log.info('Reconnect...');
            this._connectWebSocket();
        }, RECONNECT_INTERVAL);
    }

    _stopReconnect() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

if (require.main !== module) {
    module.exports = (options) => new JaroliftAdapter(options);
} else {
    new JaroliftAdapter();
}
