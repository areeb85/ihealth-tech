"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import { Button, Card, Flex, Space, Tag, message, Typography, Divider, Select } from "antd";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

// ── BLE UUIDs ────────────────────────────────────────────────────────────────
const DEVICE_NAME_SUBSTR = "HRPC";
const AFE_SERVICE_UUID = "12345678-1234-5678-1234-56789abc0000";
const AFE_CHAR_UUID    = "12345678-1234-5678-1234-56789abc0001";
const IMU_SERVICE_UUID = "12345678-1234-5678-1234-56789abc1000";
const IMU_CHAR_UUID    = "12345678-1234-5678-1234-56789abc1001";
const TMP_SERVICE_UUID = "12345678-1234-5678-1234-56789abc2000";
const TMP_CHAR_UUID    = "12345678-1234-5678-1234-56789abc2001";

// ── Packet formats ──────────────────────────────────────────────────────────
const HISTORY = 1280;
const PPG_CHANNELS = 4;
const PPG_SAMPLES_PER_PACKET = 10;
const PPG_NAMES = ["Green", "Red", "IR", "Ambient"];

// Ring buffer helper
function makeBuffer(n, fill = 0) {
  return new Array(n).fill(fill);
}

export default function Page() {
  // Device / GATT server
  const [connected, setConnected] = useState(false);
  const deviceRef = useRef(null);
  const serverRef = useRef(null);

  // Char refs
  const afeCharRef = useRef(null);
  const imuCharRef = useRef(null);
  const tmpCharRef = useRef(null);

  // Notification handler refs (so we can remove them cleanly)
  const afeHandlerRef = useRef(null);
  const imuHandlerRef = useRef(null);
  const tmpHandlerRef = useRef(null);

  // Subscription states
  const [afeOn, setAfeOn] = useState(false);
  const [imuOn, setImuOn] = useState(false);
  const [tmpOn, setTmpOn] = useState(false);

  // Data buffers
  const ppg = useRef(Array.from({ length: PPG_CHANNELS }, () => makeBuffer(HISTORY)));
  const accel = useRef([makeBuffer(HISTORY), makeBuffer(HISTORY), makeBuffer(HISTORY)]);
  const gyro  = useRef([makeBuffer(HISTORY), makeBuffer(HISTORY), makeBuffer(HISTORY)]);
  const temp  = useRef(makeBuffer(HISTORY));
  const [latestTemp, setLatestTemp] = useState(null);

  useEffect(() => {
    document.body.classList.add("hydrated");
    return () => document.body.classList.remove("hydrated");
  }, []);

  // UI: which PPG streams to show (default: only first/Green)
  const [ppgSelected, setPpgSelected] = useState([0]);

  // Chart refs (imperative updates, no React "tick")
  const ppgChartRef  = useRef(null);
  const accChartRef  = useRef(null);
  const gyroChartRef = useRef(null);
  const tmpChartRef  = useRef(null);

  // ── Decoders ───────────────────────────────────────────────────────────────
  function decodeAFE(dataView) {
    if (dataView.byteLength < 8) return;
    let offset = 8; // skip timestamp
    for (let i = 0; i < PPG_SAMPLES_PER_PACKET; i++) {
      if (offset + 5 > dataView.byteLength) break;
      const tag = dataView.getUint8(offset); offset += 1;
      const value = dataView.getUint32(offset, true); offset += 4;
      if (tag >= 0 && tag < PPG_CHANNELS) {
        const buf = ppg.current[tag];
        buf.push(value);
        if (buf.length > HISTORY) buf.shift();
      }
    }
    ppgChartRef.current?.update("none");
  }

  function decodeIMU(dataView) {
    console.log("IMU data coming in: ", dataView);
    if (dataView.byteLength < 8) return;
    let offset = 8;
    while (offset + 12 <= dataView.byteLength) {
      const ax = dataView.getInt16(offset, true); offset += 2;
      const ay = dataView.getInt16(offset, true); offset += 2;
      const az = dataView.getInt16(offset, true); offset += 2;
      const gx = dataView.getInt16(offset, true); offset += 2;
      const gy = dataView.getInt16(offset, true); offset += 2;
      const gz = dataView.getInt16(offset, true); offset += 2;
      const a = accel.current, g = gyro.current;
      a[0].push(ax); if (a[0].length > HISTORY) a[0].shift();
      a[1].push(ay); if (a[1].length > HISTORY) a[1].shift();
      a[2].push(az); if (a[2].length > HISTORY) a[2].shift();
      g[0].push(gx); if (g[0].length > HISTORY) g[0].shift();
      g[1].push(gy); if (g[1].length > HISTORY) g[1].shift();
      g[2].push(gz); if (g[2].length > HISTORY) g[2].shift();
    }
    accChartRef.current?.update("none");
    gyroChartRef.current?.update("none");
  }

  function decodeTMP(dataView) {
    if (dataView.byteLength < 10) return;
    const cNum = Number(`${dataView.getUint8(8)}.${dataView.getUint8(9)}`);
    const t = temp.current;
    t.push(cNum);
    if (t.length > HISTORY) t.shift();
    setLatestTemp(cNum);
    tmpChartRef.current?.update("none");
  }

  // ── Connect once, then start/stop notifications per stream ────────────────
  async function connectDevice() {
    try {
      if (!navigator.bluetooth) {
        message.error("Web Bluetooth not supported in this browser.");
        return;
      }

      let device;
      try {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: DEVICE_NAME_SUBSTR }],
          optionalServices: [AFE_SERVICE_UUID, IMU_SERVICE_UUID, TMP_SERVICE_UUID],
        });
      } catch (e) {
        device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [AFE_SERVICE_UUID, IMU_SERVICE_UUID, TMP_SERVICE_UUID],
        });
      }

      const server = await device.gatt.connect();
      deviceRef.current = device;
      serverRef.current = server;

      device.addEventListener("gattserverdisconnected", () => {
        setConnected(false);
        setAfeOn(false);
        setImuOn(false);
        setTmpOn(false);

        afeCharRef.current = null;
        imuCharRef.current = null;
        tmpCharRef.current = null;
        afeHandlerRef.current = null;
        imuHandlerRef.current = null;
        tmpHandlerRef.current = null;

        message.warning("BLE device disconnected");
      });

      setConnected(true);
      message.success("Device connected");
    } catch (err) {
      console.error(err);
      message.error(String(err?.message || err));
    }
  }

  // ── AFE Start/Stop ────────────────────────────────────────────────────────
  async function startNotifyAFE() {
    if (afeOn) return;
    try {
      if (!serverRef.current) return;
      if (!afeCharRef.current) {
        const svc = await serverRef.current.getPrimaryService(AFE_SERVICE_UUID);
        afeCharRef.current = await svc.getCharacteristic(AFE_CHAR_UUID);
      }
      const ch = afeCharRef.current;
      if (!afeHandlerRef.current) {
        const handler = (e) => decodeAFE(e.target.value);
        afeHandlerRef.current = handler;
        ch.addEventListener("characteristicvaluechanged", handler);
      }
      await ch.startNotifications();
      setAfeOn(true);
      message.success("AFE notifications started");
    } catch (err) {
      console.error(err);
      message.error(String(err?.message || err));
    }
  }

  async function stopNotifyAFE() {
    if (!afeOn) return;
    try {
      const ch = afeCharRef.current;
      if (!ch) return;
      if (afeHandlerRef.current) {
        ch.removeEventListener("characteristicvaluechanged", afeHandlerRef.current);
        afeHandlerRef.current = null;
      }
      await ch.stopNotifications();
      setAfeOn(false);
      message.info("AFE notifications stopped");
    } catch (err) {
      console.error(err);
      message.error(String(err?.message || err));
    }
  }

  // ── IMU Start/Stop ────────────────────────────────────────────────────────
  async function startNotifyIMU() {
    if (imuOn) return;
    try {
      if (!serverRef.current) return;
      if (!imuCharRef.current) {
        const svc = await serverRef.current.getPrimaryService(IMU_SERVICE_UUID);
        imuCharRef.current = await svc.getCharacteristic(IMU_CHAR_UUID);
      }
      const ch = imuCharRef.current;
      if (!imuHandlerRef.current) {
        const handler = (e) => decodeIMU(e.target.value);
        imuHandlerRef.current = handler;
        ch.addEventListener("characteristicvaluechanged", handler);
      }
      await ch.startNotifications();
      setImuOn(true);
      message.success("IMU notifications started");
    } catch (err) {
      console.error(err);
      message.error(String(err?.message || err));
    }
  }

  async function stopNotifyIMU() {
    if (!imuOn) return;
    try {
      const ch = imuCharRef.current;
      if (!ch) return;
      if (imuHandlerRef.current) {
        ch.removeEventListener("characteristicvaluechanged", imuHandlerRef.current);
        imuHandlerRef.current = null;
      }
      await ch.stopNotifications();
      setImuOn(false);
      message.info("IMU notifications stopped");
    } catch (err) {
      console.error(err);
      message.error(String(err?.message || err));
    }
  }

  // ── TMP Start/Stop ────────────────────────────────────────────────────────
  async function startNotifyTMP() {
    if (tmpOn) return;
    try {
      if (!serverRef.current) return;
      if (!tmpCharRef.current) {
        const svc = await serverRef.current.getPrimaryService(TMP_SERVICE_UUID);
        tmpCharRef.current = await svc.getCharacteristic(TMP_CHAR_UUID);
      }
      const ch = tmpCharRef.current;
      if (!tmpHandlerRef.current) {
        const handler = (e) => decodeTMP(e.target.value);
        tmpHandlerRef.current = handler;
        ch.addEventListener("characteristicvaluechanged", handler);
      }
      await ch.startNotifications();
      setTmpOn(true);
      message.success("TMP notifications started");
    } catch (err) {
      console.error(err);
      message.error(String(err?.message || err));
    }
  }

  async function stopNotifyTMP() {
    if (!tmpOn) return;
    try {
      const ch = tmpCharRef.current;
      if (!ch) return;
      if (tmpHandlerRef.current) {
        ch.removeEventListener("characteristicvaluechanged", tmpHandlerRef.current);
        tmpHandlerRef.current = null;
      }
      await ch.stopNotifications();
      setTmpOn(false);
      message.info("TMP notifications stopped");
    } catch (err) {
      console.error(err);
      message.error(String(err?.message || err));
    }
  }

  // ── Chart data & options ───────────────────────────────────────────────────
  const labels = useMemo(
    () => Array.from({ length: HISTORY }, (_, i) => i - HISTORY + 1),
    []
  );

  const ppgColors = [
    { borderColor: "#16a34a", backgroundColor: "rgba(22,163,74,0.08)" }, // Green
    { borderColor: "#dc2626", backgroundColor: "rgba(220,38,38,0.08)" }, // Red
    { borderColor: "#0ea5e9", backgroundColor: "rgba(14,165,233,0.08)" }, // IR
    { borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,0.08)" }, // Ambient
  ];

  const axesColors = {
    ax: "#1d4ed8", ay: "#10b981", az: "#6b21a8",
    gx: "#ef4444", gy: "#f97316", gz: "#0ea5e9",
  };

  const ppgDatasets = useMemo(
    () =>
      ppgSelected.map((i) => ({
        label: PPG_NAMES[i] ?? `Ch ${i}`,
        data: ppg.current[i],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.12,
        fill: true,
        ...ppgColors[i % ppgColors.length],
      })),
    [ppgSelected]
  );

  const ppgData  = { labels, datasets: ppgDatasets };
  const accelData = {
    labels,
    datasets: ["ax","ay","az"].map((k, i) => ({
      label: k,
      data: accel.current[i],
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.12,
      fill: false,
      borderColor: axesColors[k],
    })),
  };
  const gyroData = {
    labels,
    datasets: ["gx","gy","gz"].map((k, i) => ({
      label: k,
      data: gyro.current[i],
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.12,
      fill: false,
      borderColor: axesColors[k],
    })),
  };
  const tempData = {
    labels,
    datasets: [{
      label: "°C",
      data: temp.current,
      borderWidth: 1.8,
      pointRadius: 0,
      tension: 0.12,
      fill: true,
      borderColor: "#f59e0b",
      backgroundColor: "rgba(245,158,11,0.10)",
    }]
  };

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { intersect: false, mode: "nearest" },
    plugins: { legend: { display: true } },
    scales: {
      x: { ticks: { display: false }, grid: { display: false } },
      y: { grid: { color: "rgba(0,0,0,0.06)" } },
    },
  };

  const ppgSelectOptions = useMemo(
    () => PPG_NAMES.map((name, idx) => ({ label: name, value: idx })),
    []
  );
  const selectAll = () => setPpgSelected([0,1,2,3]);
  const selectNone = () => setPpgSelected([]);

  return (
    <div className="container">
      <div className="header">
        <Typography.Title level={3} style={{margin:0}}>
          HRPC Real-Time Sensor Visualization
        </Typography.Title>
        <Space>
          <Button type="primary" onClick={connectDevice} disabled={connected}>
            Connect Device
          </Button>
          <Divider type="vertical" />
          {/* Toggle buttons per stream */}
          <Button
            onClick={afeOn ? stopNotifyAFE : startNotifyAFE}
            disabled={!connected}
            type={afeOn ? "primary" : "default"}
          >
            {afeOn ? "Turn Off AFE" : "Turn On AFE"}
          </Button>
          <Button
            onClick={imuOn ? stopNotifyIMU : startNotifyIMU}
            disabled={!connected}
            type={imuOn ? "primary" : "default"}
          >
            {imuOn ? "Turn Off IMU" : "Turn On IMU"}
          </Button>
          <Button
            onClick={tmpOn ? stopNotifyTMP : startNotifyTMP}
            disabled={!connected}
            type={tmpOn ? "primary" : "default"}
          >
            {tmpOn ? "Turn Off TMP" : "Turn On TMP"}
          </Button>
        </Space>
      </div>

      <Space wrap>
        <Tag color={connected ? "green" : "red"}>
          Device {connected ? "Connected" : "Disconnected"}
        </Tag>
        <Tag color={afeOn ? "green" : "default"}>AFE {afeOn ? "On" : "Off"}</Tag>
        <Tag color={imuOn ? "green" : "default"}>IMU {imuOn ? "On" : "Off"}</Tag>
        <Tag color={tmpOn ? "green" : "default"}>TMP {tmpOn ? "On" : "Off"}</Tag>
        {tmpOn && (
          <span className="small">
            Current Temp: {latestTemp?.toFixed?.(2) ?? "—"} °C
          </span>
        )}
      </Space>

      <div className="charts" style={{marginTop:16}}>
        <Card
          className="card"
          title="PPG (toggle channels)"
          extra={
            <Space size="small">
              <Select
                size="small"
                style={{ minWidth: 220 }}
                mode="multiple"
                maxTagCount="responsive"
                placeholder="Select PPG channels"
                options={ppgSelectOptions}
                value={ppgSelected}
                onChange={setPpgSelected}
              />
              <Button size="small" onClick={selectAll}>All</Button>
              <Button size="small" onClick={selectNone}>None</Button>
            </Space>
          }
          bodyStyle={{height:340}}
        >
          <Line ref={ppgChartRef} data={ppgData} options={{...commonOptions}} />
        </Card>

        <Card className="card" title="Accelerometer (raw)" bodyStyle={{height:340}}>
          <Line ref={accChartRef} data={accelData} options={{...commonOptions}} />
        </Card>

        <Card className="card" title="Gyroscope (raw)" bodyStyle={{height:340}}>
          <Line ref={gyroChartRef} data={gyroData} options={{...commonOptions}} />
        </Card>

        <Card className="card" title="Temperature (°C)" bodyStyle={{height:340}}>
          <Line ref={tmpChartRef} data={tempData} options={{...commonOptions}} />
        </Card>
      </div>

      <Flex vertical gap={8} style={{marginTop:16}}>
        <Typography.Paragraph className="small">
          Connect once, then toggle per-stream notifications. Charts update automatically as data arrives.
        </Typography.Paragraph>
      </Flex>
    </div>
  );
}
