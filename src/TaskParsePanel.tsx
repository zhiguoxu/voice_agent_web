/**
 * 一句话任务解析测试面板（POST /api/agent/task/parse，挂在「API 测试」页）。
 *
 * 单条解析：输入一句话看抽取出的时间/地点/人物/播报文案；可选 device_sn
 * （走花名册消解）与打卡标记（验 enable_photo 透传）。
 * 批量回归：40 条验收 case + 3 条负例逐条打真实接口并断言，口径与
 * agent_server/oneshot_task/scripts/run_parse_cases.py 一致——once 验相对
 * 今天的日期与钟点、recurring 验星期集合、relative 验触发时刻窗口(±2/3min)。
 */
import { useRef, useState } from "react";
import {
  parseOneshotTask,
  type TaskParseExecutionTime,
  type TaskParseResponse,
} from "./api";

const FAR_END_DATE = "2099-01-01";
const DAILY = [1, 2, 3, 4, 5, 6, 7];
const WEEK_CN = "一二三四五六日";

type TimeExpect =
  | { kind: "once"; days: number; hour: number; minute: number }
  | { kind: "recurring"; weekDays: number[]; hour: number; minute: number }
  | { kind: "relative"; minutes: number };

interface CaseDef {
  no: number;
  text: string;
  time: TimeExpect;
  /** 期望地点名；null=应为 null（如「在家」不算地点） */
  location: string | null;
  /** 期望人物称呼；null=应为 null（说话人自己/多人）；"any"=语义两可不校验 */
  person: string | null | "any";
}

const once = (days: number, hour: number, minute: number): TimeExpect => ({ kind: "once", days, hour, minute });
const rec = (weekDays: number[], hour: number, minute: number): TimeExpect => ({ kind: "recurring", weekDays, hour, minute });
const rel = (minutes: number): TimeExpect => ({ kind: "relative", minutes });

const CASES: CaseDef[] = [
  { no: 1, text: "明天早上7点去主卧叫爸爸起床", time: once(1, 7, 0), location: "主卧", person: "爸爸" },
  { no: 2, text: "今天晚上10点在客厅提醒妈妈吃药", time: once(0, 22, 0), location: "客厅", person: "妈妈" },
  { no: 3, text: "每天下午3点去书房提醒小明写作业", time: rec(DAILY, 15, 0), location: "书房", person: "小明" },
  { no: 4, text: "每周一早上8点在大门口提醒我出门上班", time: rec([1], 8, 0), location: "大门口", person: null },
  { no: 5, text: "明天晚上9点在奶奶房间播报生日祝福", time: once(1, 21, 0), location: "奶奶房间", person: "any" },
  { no: 6, text: "每天晚上11点在主卧提醒我睡觉", time: rec(DAILY, 23, 0), location: "主卧", person: null },
  { no: 7, text: "明天下午2点在办公室提醒我给客户打电话", time: once(1, 14, 0), location: "办公室", person: null },
  { no: 8, text: "每天早上7点在儿童房叫孩子上网课", time: rec(DAILY, 7, 0), location: "儿童房", person: "孩子" },
  { no: 9, text: "明天中午12点在餐厅提醒全家人吃饭", time: once(1, 12, 0), location: "餐厅", person: null },
  { no: 10, text: "每天上午10点去客厅提醒我喝水", time: rec(DAILY, 10, 0), location: "客厅", person: null },
  { no: 11, text: "明天早上6点半在阳台提醒我做早操", time: once(1, 6, 30), location: "阳台", person: null },
  { no: 12, text: "每天晚上9点在书房提醒孩子刷牙", time: rec(DAILY, 21, 0), location: "书房", person: "孩子" },
  { no: 13, text: "明天上午9点在会议室提醒大家开会", time: once(1, 9, 0), location: "会议室", person: null },
  { no: 14, text: "每周五晚上8点在玄关提醒我扔垃圾", time: rec([5], 20, 0), location: "玄关", person: null },
  { no: 15, text: "明天早上5点在卧室叫我起来看日出", time: once(1, 5, 0), location: "卧室", person: null },
  { no: 16, text: "每天晚上10点15在客厅播报明日天气", time: rec(DAILY, 22, 15), location: "客厅", person: null },
  { no: 17, text: "明天下午3点在奶奶房间给她讲个故事", time: once(1, 15, 0), location: "奶奶房间", person: "奶奶" },
  { no: 18, text: "每天中午12点半在厨房提醒我吃维生素", time: rec(DAILY, 12, 30), location: "厨房", person: null },
  { no: 19, text: "明天上午11点在书房提醒我开视频会", time: once(1, 11, 0), location: "书房", person: null },
  { no: 20, text: "每周二四早上7点在书房提醒孩子晨读", time: rec([2, 4], 7, 0), location: "书房", person: "孩子" },
  { no: 21, text: "明晚8点去儿童房给孩子讲《三只小猪》", time: once(1, 20, 0), location: "儿童房", person: "孩子" },
  { no: 22, text: "每天早上8点在客厅播报早安问候", time: rec(DAILY, 8, 0), location: "客厅", person: null },
  { no: 23, text: "明天下午5点在客厅提醒我健身", time: once(1, 17, 0), location: "客厅", person: null },
  { no: 24, text: "每天晚上9点在主卧提醒我关灯睡觉", time: rec(DAILY, 21, 0), location: "主卧", person: null },
  { no: 25, text: "明天早上8点半在家提醒我去医院", time: once(1, 8, 30), location: null, person: null },
  { no: 26, text: "每周一三五早上9点提醒孩子上网课", time: rec([1, 3, 5], 9, 0), location: null, person: "孩子" },
  { no: 27, text: "明天晚上7点在儿童房播报晚安故事", time: once(1, 19, 0), location: "儿童房", person: "any" },
  { no: 28, text: "每天早上9点在厨房提醒我吃降压药", time: rec(DAILY, 9, 0), location: "厨房", person: null },
  { no: 29, text: "明天下午4点在客厅提醒我接电话", time: once(1, 16, 0), location: "客厅", person: null },
  { no: 30, text: "后天早上6点在卧室提醒我起来抢票", time: once(2, 6, 0), location: "卧室", person: null },
  { no: 31, text: "10分钟后在书房提醒我开会", time: rel(10), location: "书房", person: null },
  { no: 32, text: "半小时后在主卧提醒妈妈吃药", time: rel(30), location: "主卧", person: "妈妈" },
  { no: 33, text: "15分钟后在客厅提醒孩子写作业", time: rel(15), location: "客厅", person: "孩子" },
  { no: 34, text: "20分钟后在厨房提醒我喝水", time: rel(20), location: "厨房", person: null },
  { no: 35, text: "45分钟后在儿童房提醒孩子上网课", time: rel(45), location: "儿童房", person: "孩子" },
  { no: 36, text: "1小时后在玄关提醒我出门取快递", time: rel(60), location: "玄关", person: null },
  { no: 37, text: "5分钟后在卧室提醒爸爸起床", time: rel(5), location: "卧室", person: "爸爸" },
  { no: 38, text: "40分钟后在餐厅提醒大家吃饭", time: rel(40), location: "餐厅", person: null },
  { no: 39, text: "25分钟后在阳台提醒我做拉伸", time: rel(25), location: "阳台", person: null },
  { no: 40, text: "2小时后在儿童房提醒孩子该睡觉了", time: rel(120), location: "儿童房", person: "孩子" },
];
// 非任务描述: 必须 recognized=false（误建任务比漏识别更糟）
const NEGATIVES = ["今天天气怎么样", "把音量调大一点", "你叫什么名字"];

/** 产品时区（Asia/Shanghai）当前墙钟，与服务端 now_cst 同口径 */
function nowCst(): Date {
  return new Date(Date.now() + (new Date().getTimezoneOffset() + 8 * 60) * 60000);
}
const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
/** 墙钟 → 统一假想轴的分钟数（两侧同法构造，仅作差比较） */
const wallMinutes = (dateStr: string, hour: number, minute: number) =>
  Date.parse(`${dateStr}T00:00:00Z`) / 60000 + hour * 60 + minute;
const cstWallMinutes = (d: Date) =>
  Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 60000;
const sameArr = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function humanTime(et: TaskParseExecutionTime): string {
  const hm = `${pad2(et.hour)}:${pad2(et.minute)}`;
  if (!et.week_days.length) return `单次 ${et.start_date} ${hm}`;
  const wd = et.week_days.length === 7
    ? "每天"
    : "每周" + et.week_days.map((d) => WEEK_CN[d - 1]).join("、");
  return `${wd} ${hm}（${et.start_date} 起）`;
}

function personLabel(p: { id: string; name: string } | null): string {
  if (!p) return "无（对说话人/多人）";
  return p.id ? `${p.name}（花名册 ${p.id}）` : `${p.name}（未入花名册）`;
}

/** 批量回归的断言（与 scripts/run_parse_cases.py 同口径），返回失败原因列表 */
function checkCase(
  c: CaseDef,
  body: TaskParseResponse,
  sentAt: Date,
  deviceSn: string,
  checkin: boolean,
): string[] {
  if (body.code !== 0) return [`code=${body.code} msg=${body.msg}`];
  if (!body.data.recognized) return ["recognized=false"];
  const tpl = body.data.template;
  if (!tpl) return ["recognized=true 但 template 为 null"];
  const errs: string[] = [];
  const et = tpl.execution_time;
  const hm = `${pad2(et.hour)}:${pad2(et.minute)}`;

  const t = c.time;
  if (t.kind === "once") {
    const want = isoDate(addDays(nowCstOf(sentAt), t.days));
    if (et.start_date !== want || et.end_date !== want)
      errs.push(`日期 期望${want} 实际${et.start_date}~${et.end_date}`);
    if (et.hour !== t.hour || et.minute !== t.minute)
      errs.push(`时刻 期望${pad2(t.hour)}:${pad2(t.minute)} 实际${hm}`);
    if (et.week_days.length) errs.push(`单次任务 week_days 应为空: [${et.week_days}]`);
  } else if (t.kind === "recurring") {
    if (!sameArr(et.week_days, t.weekDays))
      errs.push(`week_days 期望[${t.weekDays}] 实际[${et.week_days}]`);
    if (et.hour !== t.hour || et.minute !== t.minute)
      errs.push(`时刻 期望${pad2(t.hour)}:${pad2(t.minute)} 实际${hm}`);
    if (et.end_date !== FAR_END_DATE) errs.push(`end_date 期望${FAR_END_DATE} 实际${et.end_date}`);
    if (et.start_date !== isoDate(nowCstOf(sentAt))) errs.push(`start_date 期望今天 实际${et.start_date}`);
  } else {
    // relative: 触发时刻落在 [发送+off-2min, 发送+off+3min]（容请求耗时）
    const got = wallMinutes(et.start_date, et.hour, et.minute);
    const sent = cstWallMinutes(nowCstOf(sentAt));
    if (Number.isNaN(got) || got < sent + t.minutes - 2 || got > sent + t.minutes + 3)
      errs.push(`相对时刻 期望≈发送后${t.minutes}分钟 实际${et.start_date} ${hm}`);
    if (et.week_days.length) errs.push(`相对任务 week_days 应为空: [${et.week_days}]`);
  }

  if (c.location === null) {
    if (tpl.location) errs.push(`地点应为 null, 实际${tpl.location.name}`);
  } else if (!tpl.location || tpl.location.name !== c.location) {
    errs.push(`地点 期望${c.location} 实际${tpl.location?.name ?? "null"}`);
  }

  if (c.person === null) {
    if (tpl.target_person) errs.push(`人物应为 null, 实际${tpl.target_person.name}`);
  } else if (c.person !== "any") {
    if (!tpl.target_person) errs.push(`人物 期望${c.person} 实际 null`);
    else if (!deviceSn && tpl.target_person.name !== c.person)
      // 未带设备 → 不走花名册, name 必须是句中原称呼
      errs.push(`人物 期望${c.person} 实际${tpl.target_person.name}`);
    else if (!deviceSn && tpl.target_person.id !== "")
      errs.push(`未带设备时人物 id 应为空串: ${tpl.target_person.id}`);
  }

  if (!tpl.content.tts_text) errs.push("tts_text 为空");
  if (!tpl.name) errs.push("任务名为空");
  if (checkin && !tpl.enable_photo) errs.push("isCheckinTask=true 未透传为 enable_photo");
  return errs;
}

/** sentAt 已是 nowCst() 的返回值，原样用；抽个名字只为读起来不歧义 */
const nowCstOf = (sentAt: Date) => sentAt;

interface SingleResult {
  text: string;
  resp: TaskParseResponse;
}

interface BatchRow {
  label: string;
  text: string;
  ok: boolean;
  note: string;
}

export function TaskParsePanel() {
  const [text, setText] = useState("");
  const [deviceSn, setDeviceSn] = useState("");
  const [checkin, setCheckin] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SingleResult[]>([]);

  const [batchRunning, setBatchRunning] = useState(false);
  const [batchRows, setBatchRows] = useState<BatchRow[]>([]);
  const [progress, setProgress] = useState("");
  const stopRef = useRef(false);

  const busy = parsing || batchRunning;

  const runSingle = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setParsing(true);
    setError(null);
    try {
      const resp = await parseOneshotTask(q, checkin, deviceSn.trim());
      setResults((prev) => [{ text: q, resp }, ...prev].slice(0, 10));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setParsing(false);
    }
  };

  const runBatch = async () => {
    if (busy) return;
    setBatchRunning(true);
    setError(null);
    setBatchRows([]);
    stopRef.current = false;
    const total = CASES.length + NEGATIVES.length;
    let done = 0;
    const push = (row: BatchRow) => setBatchRows((prev) => [...prev, row]);
    for (const c of CASES) {
      if (stopRef.current) break;
      setProgress(`${++done}/${total}`);
      const sentAt = nowCst();
      try {
        const resp = await parseOneshotTask(c.text, checkin, deviceSn.trim());
        const errs = checkCase(c, resp, sentAt, deviceSn.trim(), checkin);
        const tpl = resp.data.template;
        push({
          label: String(c.no),
          text: c.text,
          ok: errs.length === 0,
          note: errs.length
            ? errs.join("；")
            : `${tpl ? humanTime(tpl.execution_time) : ""} · 地点 ${tpl?.location?.name ?? "无"} · 人物 ${tpl?.target_person?.name ?? "无"}`,
        });
      } catch (e) {
        push({ label: String(c.no), text: c.text, ok: false,
               note: `请求失败: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    for (const t of NEGATIVES) {
      if (stopRef.current) break;
      setProgress(`${++done}/${total}`);
      try {
        const resp = await parseOneshotTask(t, checkin, deviceSn.trim());
        const ok = resp.code === 0 && !resp.data.recognized;
        push({
          label: "负例",
          text: t,
          ok,
          note: ok ? "recognized=false ✓" : `应 recognized=false, 实际 ${JSON.stringify(resp.data.recognized)}`,
        });
      } catch (e) {
        push({ label: "负例", text: t, ok: false,
               note: `请求失败: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    setProgress("");
    setBatchRunning(false);
  };

  const passed = batchRows.filter((r) => r.ok).length;

  return (
    <div className="card cfg-card cfg-intent-card">
      <h3>
        📝 一句话任务解析
        <span className="subtitle">
          POST /api/agent/task/parse：LLM 抽取时间/地点/人物/播报文案（真实链路，结果不落库）
        </span>
      </h3>

      <div className="cfg-intent-test">
        <input
          type="text"
          placeholder="一句话任务描述，如「明天早上7点去主卧叫爸爸起床」"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSingle()}
          disabled={busy}
        />
        <button onClick={runSingle} disabled={busy || !text.trim()}>
          {parsing ? <span className="spinner inline" /> : "解析"}
        </button>
      </div>

      <div className="task-parse-opts">
        <select
          value=""
          onChange={(e) => e.target.value && setText(e.target.value)}
          disabled={busy}
        >
          <option value="">填入预置 case…</option>
          <optgroup label="40 条验收 case">
            {CASES.map((c) => (
              <option key={c.no} value={c.text}>
                {c.no}. {c.text}
              </option>
            ))}
          </optgroup>
          <optgroup label="负例（应 recognized=false）">
            {NEGATIVES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
        </select>
        <input
          type="text"
          className="task-parse-sn"
          placeholder="device_sn（可选，走花名册消解）"
          value={deviceSn}
          onChange={(e) => setDeviceSn(e.target.value)}
          disabled={busy}
        />
        <label>
          <input
            type="checkbox"
            checked={checkin}
            onChange={(e) => setCheckin(e.target.checked)}
            disabled={busy}
          />
          打卡任务（enable_photo）
        </label>
        <button onClick={batchRunning ? () => (stopRef.current = true) : runBatch} disabled={parsing}>
          {batchRunning ? "停止" : `批量回归（${CASES.length + NEGATIVES.length} 条）`}
        </button>
        {batchRunning && (
          <span className="task-parse-progress">
            <span className="spinner inline" /> 逐条打真 LLM，跑到 {progress}…
          </span>
        )}
      </div>

      {error && <div className="cfg-error">❌ 解析失败: {error}</div>}

      {results.length > 0 && (
        <div className="cfg-intent-results">
          {results.map((r, i) => {
            const { code, msg, data } = r.resp;
            const tpl = data.template;
            return (
              <div className="cfg-intent-result cfg-mod-result" key={results.length - i}>
                <div className="cfg-mod-head">
                  <span className="cfg-intent-query">{r.text}</span>
                  {code !== 0 ? (
                    <span className="cfg-badge hit down">✘ code={code} {msg}</span>
                  ) : (
                    <span className={`cfg-badge hit ${data.recognized ? "ok" : "down"}`}>
                      {data.recognized ? "✔ 识别为任务" : "✘ 未识别为任务"}
                    </span>
                  )}
                  {tpl && <span className="cfg-badge">⏰ {humanTime(tpl.execution_time)}</span>}
                  {tpl?.enable_photo && <span className="cfg-badge modified">📷 拍照取证</span>}
                </div>
                {tpl && (
                  <div className="cfg-mod-layers">
                    <span className="cfg-mod-layer">任务名 <code>{tpl.name}</code></span>
                    <span className="cfg-mod-layer">地点 <code>{tpl.location?.name ?? "无"}</code></span>
                    <span className="cfg-mod-layer">人物 <code>{personLabel(tpl.target_person)}</code></span>
                    <span className="cfg-mod-layer">播报 <code>{tpl.content.tts_text}</code></span>
                  </div>
                )}
                <details className="task-parse-raw">
                  <summary>原始响应</summary>
                  <pre>{JSON.stringify(r.resp, null, 2)}</pre>
                </details>
              </div>
            );
          })}
        </div>
      )}

      {batchRows.length > 0 && (
        <>
          <h4 className="cfg-section-title">
            批量回归
            <span className="cfg-section-key">
              通过 {passed}/{batchRows.length}
              {batchRunning ? "（进行中）" : ""}；断言口径与 run_parse_cases.py 一致，✗ 是抽取质量信号，去「系统配置」在线调 oneshot_task.system_prompt 后重跑
            </span>
          </h4>
          <table className="vad-combo-table">
            <thead>
              <tr>
                <th>#</th>
                <th>语句</th>
                <th>结果</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {batchRows.map((r, i) => (
                <tr key={i}>
                  <td className="cfg-number">{r.label}</td>
                  <td>{r.text}</td>
                  <td>
                    <span className={`cfg-badge hit ${r.ok ? "ok" : "down"}`}>{r.ok ? "✔" : "✘"}</span>
                  </td>
                  <td className="task-parse-note">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
