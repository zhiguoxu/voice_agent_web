export interface DeviceAction {
    id: number;
    en_name: string;
    zh_name: string;
}

export const DEVICE_ACTIONS: DeviceAction[] = [
    {id: 1, en_name: "microphone_action", zh_name: "麦克风动作"},
    {id: 2, en_name: "happy_wave", zh_name: "开心挥手"},
    {id: 3, en_name: "right_hand_wave", zh_name: "右手挥手"},
    {id: 4, en_name: "arm_reset", zh_name: "手臂复位"},
    {id: 5, en_name: "right_hand_handshake", zh_name: "右手握手"},
    {id: 6, en_name: "right_hand_salute", zh_name: "右手敬礼"},
    {id: 7, en_name: "both_hands_scratch_head", zh_name: "双手挠头"},
    {id: 8, en_name: "nod_head", zh_name: "点头"},
    {id: 9, en_name: "shake_head", zh_name: "摇头"},
    {id: 10, en_name: "head_reset", zh_name: "头部复位"},
    {id: 11, en_name: "right_hand_greet", zh_name: "右手打招呼"},
    {id: 12, en_name: "left_hand_greet", zh_name: "左手打招呼"},
    {id: 13, en_name: "right_hand_smirk", zh_name: "右手偷笑"},
    {id: 14, en_name: "both_hands_happy_action", zh_name: "双手开心动作"},
    {id: 15, en_name: "both_hands_dance_action", zh_name: "双手跳舞动作"},
    {id: 16, en_name: "both_hands_cheer_flip_up", zh_name: "双手欢呼（手臂翻转向上）"},
    {id: 17, en_name: "both_hands_cheer_lift_up", zh_name: "双手欢呼（手臂自然向上）"},
    {id: 18, en_name: "hands_on_hips", zh_name: "双手叉腰"},
    {id: 19, en_name: "stretch_right_hand_up", zh_name: "舒展身体右手举起"},
    {id: 20, en_name: "stretch_left_hand_up", zh_name: "舒展身体左手举起"},
    {id: 21, en_name: "left_hand_wave", zh_name: "左手挥手"},
    {id: 22, en_name: "open_hands_and_shake_head", zh_name: "张开双手 + 摇头"},
    {id: 23, en_name: "right_gesture_and_head_right_turn", zh_name: "右手比划 + 头右转"},
    {id: 24, en_name: "left_gesture_and_head_left_turn", zh_name: "左手比划 + 头左转"},
    {id: 25, en_name: "open_hands_and_nod_head", zh_name: "双手张开 + 点头"},
    {id: 26, en_name: "hands_over_head_and_shake_head", zh_name: "双手举过头顶 + 摇头"},
    {id: 27, en_name: "lift_left_hand_and_head_left_turn", zh_name: "左抬手 + 头左转"},
    {id: 28, en_name: "lift_right_hand_and_head_right_turn", zh_name: "右抬手 + 头右转"},
    {id: 29, en_name: "squat_and_open_hands", zh_name: "下蹲 + 双手张开"},
    {id: 30, en_name: "sway_and_cheer", zh_name: "左右摇摆 + 双手欢呼"},
    {id: 31, en_name: "continuous_wave", zh_name: "持续招手"},
    {id: 32, en_name: "right_arm_reset", zh_name: "右手臂复位"},
    {id: 33, en_name: "open_left_hand_and_look_up", zh_name: "左手张开 + 抬头"},
    {id: 34, en_name: "squat", zh_name: "下蹲"},
    {id: 35, en_name: "lift_left_hand_100_degrees", zh_name: "左手上抬 100 度"},
    {id: 36, en_name: "lift_left_hand_30_degrees", zh_name: "左手上抬 30 度"},
    {id: 37, en_name: "lift_right_hand_100_degrees", zh_name: "右手上抬 100 度"},
    {id: 38, en_name: "lift_right_hand_30_degrees", zh_name: "右手上抬 30 度"},
    {id: 39, en_name: "body_turn_right", zh_name: "身体右转"},
    {id: 40, en_name: "body_turn_left", zh_name: "身体左转"},
    {id: 41, en_name: "horizontal_lift_left_hand_20_degrees", zh_name: "左手平抬 20 度"},
    {id: 42, en_name: "horizontal_lift_right_hand_20_degrees", zh_name: "右手平抬 20 度"},
    {id: 43, en_name: "horizontal_lift_both_hands_20_degrees", zh_name: "双手平抬 20 度"},
    {id: 44, en_name: "left_hand_invite", zh_name: "左手邀请"},
    {id: 45, en_name: "right_hand_invite", zh_name: "右手邀请"},
    {id: 46, en_name: "lift_left_hand_to_chest", zh_name: "左手举到胸前"},
    {id: 47, en_name: "lift_right_hand_to_chest", zh_name: "右手举到胸前"},
    {id: 48, en_name: "open_left_hand", zh_name: "左手张开"},
    {id: 49, en_name: "open_right_hand", zh_name: "右手张开"},
    {id: 50, en_name: "forward_backward_sway", zh_name: "前后摇摆"},
    {id: 51, en_name: "look_up_20_degrees", zh_name: "抬头 20 度"},
    {id: 52, en_name: "look_down_20_degrees", zh_name: "低头 20 度"},
    {id: 53, en_name: "side_to_side_sway", zh_name: "左右摇摆"},
    {id: 54, en_name: "look_left", zh_name: "左看"},
    {id: 55, en_name: "look_right", zh_name: "右看"}
];
export const INTENT_ACTIONS = [
  {
    "en_name": "query_volume",
    "zh_name": "查询音量",
    "payload": {
      "type": "query-volume",
      "payload": {
        "source_type": "robot"
      }
    },
    "icon": "🔉"
  },
  {
    "en_name": "increase_volume",
    "zh_name": "调大音量",
    "payload": {
      "payload": {
        "mode": "relative",
        "source_type": "robot",
        "value": 10
      },
      "type": "set-volume"
    },
    "icon": "🔊"
  },
  {
    "en_name": "decrease_volume",
    "zh_name": "调小音量",
    "payload": {
      "payload": {
        "mode": "relative",
        "source_type": "robot",
        "value": -10
      },
      "type": "set-volume"
    },
    "icon": "🔈"
  },
  {
    "en_name": "max_volume",
    "zh_name": "最大音量",
    "payload": {
      "payload": {
        "mode": "absolute",
        "source_type": "robot",
        "value": 100.0
      },
      "type": "set-volume"
    },
    "icon": "📢"
  },
  {
    "en_name": "move_forward",
    "zh_name": "向前走",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "move",
          "param": {
            "distance": 0.5,
            "duration": 0,
            "type": "go-forward"
          }
        }
      ]
    },
    "icon": "⬆️"
  },
  {
    "en_name": "move_backward",
    "zh_name": "后退",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "move",
          "param": {
            "distance": 0.5,
            "duration": 0,
            "type": "go-backward"
          }
        }
      ]
    },
    "icon": "⬇️"
  },
  {
    "en_name": "follow",
    "zh_name": "进入跟随",
    "payload": {
      "type": "follow",
      "payload": {
        "ID": ""
      }
    },
    "icon": "👣"
  },
  {
    "en_name": "stop_follow",
    "zh_name": "退出跟随",
    "payload": {
      "type": "stop"
    },
    "icon": "🛑"
  },
  {
    "en_name": "mount",
    "zh_name": "上车",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "on-off-car",
          "param": {
            "type": "get-on"
          }
        }
      ]
    },
    "icon": "🚗"
  },
  {
    "en_name": "dismount",
    "zh_name": "下车",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "on-off-car",
          "param": {
            "type": "get-off"
          }
        }
      ]
    },
    "icon": "🚶"
  },
  {
    "en_name": "stand_up",
    "zh_name": "爬起",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "get-up"
        }
      ]
    },
    "icon": "🧍"
  },
  {
    "en_name": "charge",
    "zh_name": "充电",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "go-charge"
        }
      ]
    },
    "icon": "🔋"
  },
  {
    "en_name": "slide_left",
    "zh_name": "向左移",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "move",
          "param": {
            "type": "go-left",
            "distance": 0.5,
            "duration": 0
          }
        }
      ]
    },
    "icon": "⬅️"
  },
  {
    "en_name": "slide_right",
    "zh_name": "向右移",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "move",
          "param": {
            "type": "go-right",
            "distance": 0.5,
            "duration": 0
          }
        }
      ]
    },
    "icon": "➡️"
  },
  {
    "en_name": "patrol",
    "zh_name": "进入巡逻",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "patrol",
          "param": {
            "type": "auto",
            "points": []
          }
        }
      ]
    },
    "icon": "👮"
  },
  {
    "en_name": "rotation_left",
    "zh_name": "左转",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "move",
          "param": {
            "type": "spin-left",
            "angle": 90.0,
            "duration": 0
          }
        }
      ]
    },
    "icon": "↺"
  },
  {
    "en_name": "rotation_right",
    "zh_name": "右转",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "move",
          "param": {
            "type": "spin-right",
            "angle": 90.0,
            "duration": 0
          }
        }
      ]
    },
    "icon": "↻"
  },
  {
    "en_name": "stop",
    "zh_name": "停止",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "stop"
        }
      ]
    },
    "icon": "🛑"
  },
  {
    "en_name": "walk_left",
    "zh_name": "往左走",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "move",
          "param": {
            "type": "turn-left",
            "distance": 0.5,
            "duration": 0
          }
        }
      ]
    },
    "icon": "↖️"
  },
  {
    "en_name": "walk_right",
    "zh_name": "往右走",
    "payload": {
      "type": "instruction",
      "instruction": [
        {
          "name": "move",
          "param": {
            "type": "turn-right",
            "distance": 0.5,
            "duration": 0
          }
        }
      ]
    },
    "icon": "↗️"
  }
];
