# ioBroker Jarolift Adapter

ioBroker Adapter für den [ESP32-Jarolift-Controller](https://github.com/dewenni/ESP32-Jarolift-Controller) von dewenni.

Kommuniziert direkt per **WebSocket** (`ws://<IP>/ws`) mit dem ESP32.

---

## Installation

### Option A – über den ioBroker Adapter-Manager (manuell)

1. ioBroker Admin öffnen → **Adapter** → **Aus eigener URL installieren**
2. URL eingeben: `https://github.com/your/iobroker.jarolift`
3. Instanz anlegen und konfigurieren

### Option B – direkt per npm

```bash
cd /opt/iobroker
npm install /pfad/zu/iobroker.jarolift
iobroker add jarolift
```

---

## Konfiguration

| Feld | Beschreibung |
|---|---|
| IP-Adresse | IP des ESP32 (z.B. `192.168.66.43`) |
| Anzahl Kanäle | 1–16 (nur konfigurierte Kanäle werden angelegt) |
| Anzahl Gruppen | 0–6 |
| Kanal-Namen | Individueller Name pro Kanal |
| Gruppen-Namen | Individueller Name pro Gruppe |

---

## Datenpunkte

### Kanäle

```
jarolift.0.channels.0.up           → true setzen = Kanal 1 hoch
jarolift.0.channels.0.down         → true setzen = Kanal 1 runter
jarolift.0.channels.0.stop         → true setzen = Kanal 1 stop
jarolift.0.channels.0.shade        → true setzen = Kanal 1 Schattenstellung
jarolift.0.channels.0.command      → "up" / "down" / "stop" / "shade"
jarolift.0.channels.0.lastCommand  → letzter gesendeter Befehl (read-only)
```

### Gruppen

```
jarolift.0.groups.0.up
jarolift.0.groups.0.down
jarolift.0.groups.0.stop
jarolift.0.groups.0.shade
jarolift.0.groups.0.command
jarolift.0.groups.0.lastCommand
```

### Info

```
jarolift.0.info.connection    → WebSocket verbunden (bool)
jarolift.0.info.ip            → IP-Adresse des Controllers
jarolift.0.info.uptime        → Uptime des Controllers
jarolift.0.info.mqtt_status   → MQTT Status
jarolift.0.info.wifi_signal   → WLAN Signalstärke
```

---

## Blockly / Skript Beispiel

```javascript
// Kanal 1 hochfahren
setState('jarolift.0.channels.0.up', true);

// Gruppe 1 Schattenstellung
setState('jarolift.0.groups.0.shade', true);

// Per command-State
setState('jarolift.0.channels.2.command', 'down');
```

---

## Hinweis zum Status

Die Jarolift-Motoren senden keinen Rückkanal. Der `lastCommand` Datenpunkt zeigt den zuletzt gesendeten Befehl – nicht den tatsächlichen Motorstatus.
