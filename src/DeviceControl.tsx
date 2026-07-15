import React, { useState, useMemo, useRef } from "react";
import { DEVICE_ACTIONS, INTENT_ACTIONS } from "./actions";
import { sendAction, sendMqttCommand, type Session } from "./api";
import "./DeviceControl.css";

interface DeviceControlProps {
  sessions: Session[];
}

interface JointDef {
  id: string;
  name: string;
  min: number;
  max: number;
}

const JOINTS: JointDef[] = [
  { id: "head_yaw", name: "头部偏航", min: -40, max: 40 },
  { id: "head_pitch", name: "头部俯仰", min: -31, max: 37 },
  { id: "left_arm_elbow", name: "左肘", min: -130, max: 0 },
  { id: "left_arm_shoulder_roll", name: "左肩横滚", min: -115, max: -10 },
  { id: "left_arm_shoulder_pitch", name: "左肩俯仰", min: -135, max: 180 },
  { id: "right_arm_elbow", name: "右肘", min: -130, max: 100 },
  { id: "right_arm_shoulder_roll", name: "右肩横滚", min: -115, max: -10 },
  { id: "right_arm_shoulder_pitch", name: "右肩俯仰", min: -135, max: 180 },
];

export function DeviceControl({ sessions }: DeviceControlProps) {
  const [deviceSn, setDeviceSn] = useState("");
  const [deviceTypeId, setDeviceTypeId] = useState("2");
  const [loadingAction, setLoadingAction] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Servo states
  const [secMode, setSecMode] = useState(false);
  const [sendingCmd, setSendingCmd] = useState(false);
  const [jointStates, setJointStates] = useState<Record<string, { selected: boolean; angle: number; time: number }>>(() => {
    const init: Record<string, { selected: boolean; angle: number; time: number }> = {};
    for (const j of JOINTS) {
      const defaultAngle = (j.min <= 0 && j.max >= 0) ? 0 : Math.round((j.min + j.max) / 2);
      init[j.id] = { selected: false, angle: defaultAngle, time: 1000 };
    }
    return init;
  });

  // Extract unique devices from sessions
  const uniqueDevices = useMemo(() => {
    const map = new Map<string, { sn: string; typeId: string }>();
    for (const s of sessions) {
      if (s.device_sn) {
        map.set(s.device_sn, { sn: s.device_sn, typeId: s.device_type_id || "2" });
      }
    }
    return Array.from(map.values());
  }, [sessions]);

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const sn = e.target.value;
    const device = uniqueDevices.find((d) => d.sn === sn);
    if (device) {
      setDeviceSn(device.sn);
      setDeviceTypeId(device.typeId);
    } else {
      setDeviceSn("");
      setDeviceTypeId("2");
    }
  };

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showMessage = (text: string, type: "success" | "error") => {
    setMessage({ text, type });
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setMessage(null), type === "success" ? 3000 : 5000);
  };

  const checkDevice = () => {
    if (!deviceSn) {
      showMessage("请输入或选择设备 SN", "error");
      return false;
    }
    if (!deviceTypeId) {
      showMessage("请输入设备类型 ID", "error");
      return false;
    }
    return true;
  };

  const handleSendAction = async (actionId: number) => {
    if (!checkDevice()) return;

    setLoadingAction(actionId);
    try {
      await sendAction(deviceSn, deviceTypeId, actionId);
      showMessage(`指令发送成功！(动作ID: ${actionId})`, "success");
    } catch (err: any) {
      showMessage(`发送失败: ${err.message}`, "error");
    } finally {
      setLoadingAction(null);
    }
  };

  const handleSendIntentAction = async (action: any, indexId: number) => {
    if (!checkDevice()) return;

    setLoadingAction(indexId);
    try {
      await sendMqttCommand(deviceSn, deviceTypeId, action.payload);
      showMessage(`指令发送成功！(${action.zh_name})`, "success");
    } catch (err: any) {
      showMessage(`发送失败: ${err.message}`, "error");
    } finally {
      setLoadingAction(null);
    }
  };

  const handleToggleSecMode = async () => {
    if (!checkDevice()) return;
    const newMode = !secMode;
    try {
      await sendMqttCommand(deviceSn, deviceTypeId, {
        type: "sec_develop_control",
        payload: { status: newMode ? "on" : "off" }
      });
      setSecMode(newMode);
      showMessage(`已下发舵机控制模式: ${newMode ? '开启 (on)' : '关闭 (off)'}`, "success");
    } catch (err: any) {
      showMessage(`切换模式失败: ${err.message}`, "error");
    }
  };

  const handleJointChange = (id: string, field: "selected" | "angle" | "time", value: any) => {
    setJointStates(prev => ({
      ...prev,
      [id]: { ...prev[id], [field]: value }
    }));
  };

  const handleSendCombo = async () => {
    if (!checkDevice()) return;
    
    const selectedJoints = JOINTS.filter(j => jointStates[j.id].selected);
    if (selectedJoints.length === 0) {
      showMessage("请至少勾选一个舵机关节", "error");
      return;
    }

    setSendingCmd(true);
    try {
      let payloadObj: any;
      
      if (selectedJoints.length === 1) {
        const j = selectedJoints[0];
        const state = jointStates[j.id];
        payloadObj = {
          trace: "",
          type: "sec_develop",
          command: "single_motor_control",
          payload: {
            joint_id: j.id,
            angle_deg: state.angle,
            time_ms: state.time,
            timeout_ms: 2000,
            callback_url: null
          }
        };
      } else {
        payloadObj = {
          type: "sec_develop",
          command: "multi_motor_control",
          payload: {
            sync: true,
            timeout_ms: 2000,
            joints: selectedJoints.map(j => ({
              joint_id: j.id,
              angle_deg: jointStates[j.id].angle,
              time_ms: jointStates[j.id].time
            })),
            callback_url: null
          }
        };
      }

      await sendMqttCommand(deviceSn, deviceTypeId, payloadObj);
      showMessage(`组合指令发送成功！(影响 ${selectedJoints.length} 个关节)`, "success");
    } catch (err: any) {
      showMessage(`组合指令发送失败: ${err.message}`, "error");
    } finally {
      setSendingCmd(false);
    }
  };

  return (
    <div className="device-control-container">
      {message && (
        <div className={`message-banner ${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="device-selector card">
        <h3>设备配置</h3>
        <div className="device-form-row">
          <div className="form-group">
            <label>从历史会话中选择设备：</label>
            <select onChange={handleDeviceChange} value={uniqueDevices.find(d => d.sn === deviceSn) ? deviceSn : ""}>
              <option value="">-- 选择近期活动的设备 --</option>
              {uniqueDevices.map((d) => (
                <option key={d.sn} value={d.sn}>
                  {d.sn} ({d.typeId})
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="device-form-row">
          <div className="form-group">
            <label>Device SN:</label>
            <input
              type="text"
              placeholder="手动输入设备 SN"
              value={deviceSn}
              onChange={(e) => setDeviceSn(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Device Type ID:</label>
            <input
              type="text"
              placeholder="手动输入设备 Type ID"
              value={deviceTypeId}
              onChange={(e) => setDeviceTypeId(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="servo-control-container card">
        <div className="servo-header">
          <h3>舵机角度控制 (Sec Develop)</h3>
          <button 
            className={`toggle-btn ${secMode ? 'active' : ''}`}
            onClick={handleToggleSecMode}
          >
            <span className="toggle-circle"></span>
            {secMode ? '模式已开启' : '模式已关闭'}
          </button>
        </div>
        
        <div className="servo-table">
          <div className="servo-table-header">
            <div className="col-check">启用</div>
            <div className="col-name">关节名称</div>
            <div className="col-slider">角度控制</div>
            <div className="col-time">时间 (ms)</div>
          </div>
          {JOINTS.map(j => {
            const state = jointStates[j.id];
            return (
              <div key={j.id} className={`servo-row ${state.selected ? 'active' : ''}`}>
                <div className="col-check">
                  <input 
                    type="checkbox" 
                    checked={state.selected}
                    onChange={(e) => handleJointChange(j.id, "selected", e.target.checked)}
                  />
                </div>
                <div className="col-name">
                  <div className="zh-name">{j.name}</div>
                  <div className="en-name">{j.id}</div>
                </div>
                <div className="col-slider">
                  <span className="bound-label min">{j.min}°</span>
                  <input 
                    type="range" 
                    min={j.min} 
                    max={j.max} 
                    value={state.angle}
                    disabled={!state.selected}
                    onChange={(e) => handleJointChange(j.id, "angle", Number(e.target.value))}
                    className="slider-input"
                  />
                  <span className="bound-label max">{j.max}°</span>
                  <input 
                    type="number" 
                    className="angle-input"
                    min={j.min}
                    max={j.max}
                    value={state.angle}
                    disabled={!state.selected}
                    onChange={(e) => {
                      let val = Number(e.target.value);
                      if (val < j.min) val = j.min;
                      if (val > j.max) val = j.max;
                      handleJointChange(j.id, "angle", val);
                    }}
                  />
                </div>
                <div className="col-time">
                  <input 
                    type="number" 
                    min={100}
                    step={100}
                    value={state.time}
                    disabled={!state.selected}
                    onChange={(e) => handleJointChange(j.id, "time", Number(e.target.value))}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="servo-footer">
          <button 
            className="send-combo-btn" 
            disabled={sendingCmd || JOINTS.filter(j => jointStates[j.id].selected).length === 0}
            onClick={handleSendCombo}
          >
            {sendingCmd ? "发送中..." : `发送组合指令 (${JOINTS.filter(j => jointStates[j.id].selected).length} 个关节)`}
          </button>
        </div>
      </div>

      <div className="actions-grid-container card">
        <h3>系统意图指令控制面板 <span className="subtitle">来自于 intent_rules.json</span></h3>
        <div className="actions-grid">
          {INTENT_ACTIONS.map((action, idx) => (
            <button
              key={action.en_name}
              className={`action-btn ${loadingAction === 1000 + idx ? "loading" : ""}`}
              disabled={loadingAction !== null}
              onClick={() => handleSendIntentAction(action, 1000 + idx)}
              data-tip={`English: ${action.en_name}\nPayload: ${JSON.stringify(action.payload)}`}
            >
              <span className="action-id" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-primary)', fontSize: '16px' }}>{action.icon}</span>
              <span className="action-name">{action.zh_name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="actions-grid-container card">
        <h3>内置动作控制面板 <span className="subtitle">点击下方按钮直接下发指令</span></h3>
        <div className="actions-grid">
          {DEVICE_ACTIONS.map((action) => (
            <button
              key={action.id}
              className={`action-btn ${loadingAction === action.id ? "loading" : ""}`}
              disabled={loadingAction !== null}
              onClick={() => handleSendAction(action.id)}
              data-tip={`English: ${action.en_name}\nID: ${action.id}`}
            >
              <span className="action-id">{action.id}</span>
              <span className="action-name">{action.zh_name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
