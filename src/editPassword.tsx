/**
 * 配置编辑口令的共享逻辑：弹窗输入 + sessionStorage 缓存 + 401 清缓存重试。
 *
 * 「系统配置」页（ConfigView 的在线编辑）和 vision 页 Controls 滑块
 * （写 person_id 的 DB 配置覆盖）共用同一个后端口令与同一个缓存键：
 * 任一处通过验证后，本标签页内另一处免输；口令错误（401）时清缓存重弹。
 *
 * 用法：
 *   const { withPassword, passwordDialog } = useEditPassword();
 *   await withPassword((pw) => putSomething(path, value, pw));
 *   // 组件 JSX 里渲染 {passwordDialog}（弹窗挂载点）
 */
/* eslint-disable react-refresh/only-export-components --
   工具模块: PasswordDialog 只与 useEditPassword 配套内部使用, 不参与 fast refresh */
import { useCallback, useRef, useState, type ReactNode } from "react";
import "./editPassword.css"; // cfg-pw-* 弹窗样式
import "./ConfigView.css"; // cfg-edit-* 按钮样式(与 ConfigView 行内编辑共享)

const PW_STORAGE_KEY = "cfg-edit-password";

/** 编辑口令弹窗：Enter 确认、Escape/点遮罩取消 */
function PasswordDialog({
  hint,
  onSubmit,
  onCancel,
}: {
  hint: string;
  onSubmit: (pw: string) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  return (
    <div className="cfg-pw-overlay" onClick={onCancel}>
      <div className="cfg-pw-dialog" onClick={(e) => e.stopPropagation()}>
        <h4>🔑 编辑口令</h4>
        <p className="cfg-pw-hint">{hint}</p>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pw) onSubmit(pw);
            if (e.key === "Escape") onCancel();
          }}
          placeholder="请输入口令"
        />
        <div className="cfg-edit-actions">
          <button className="cfg-edit-save" onClick={() => pw && onSubmit(pw)} disabled={!pw}>确认</button>
          <button className="cfg-edit-cancel" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  );
}

export function useEditPassword(): {
  /** 给编辑请求包上口令：无缓存先弹窗要，口令错(401)清缓存重弹，其余错误原样抛给调用方展示 */
  withPassword: <T>(call: (pw: string) => Promise<T>) => Promise<T>;
  /** 弹窗挂载点，渲染进使用方的 JSX（无弹窗时为 null） */
  passwordDialog: ReactNode;
} {
  const [pwPrompt, setPwPrompt] = useState<{
    hint: string;
    resolve: (pw: string) => void;
    reject: (e: Error) => void;
  } | null>(null);
  // 单飞：滑块拖动可能并发触发多次写请求，只弹一个口令框，后到的等同一个输入结果
  const pendingRef = useRef<Promise<string> | null>(null);

  const askPassword = useCallback((hint: string) => {
    if (pendingRef.current) return pendingRef.current;
    const p = new Promise<string>((resolve, reject) => {
      setPwPrompt({ hint, resolve, reject });
    });
    pendingRef.current = p;
    const clear = () => { pendingRef.current = null; };
    p.then(clear, clear);
    return p;
  }, []);

  const withPassword = useCallback(
    async <T,>(call: (pw: string) => Promise<T>): Promise<T> => {
      let pw = sessionStorage.getItem(PW_STORAGE_KEY)
        ?? await askPassword("修改配置需要口令验证（保存在本标签页，关闭后需重新输入）");
      for (;;) {
        try {
          const result = await call(pw);
          sessionStorage.setItem(PW_STORAGE_KEY, pw);
          return result;
        } catch (e) {
          if ((e as { status?: number }).status === 401) {
            sessionStorage.removeItem(PW_STORAGE_KEY);
            pw = await askPassword("口令错误，请重新输入");
            continue;
          }
          throw e;
        }
      }
    },
    [askPassword],
  );

  const passwordDialog = pwPrompt ? (
    <PasswordDialog
      hint={pwPrompt.hint}
      onSubmit={(pw) => { pwPrompt.resolve(pw); setPwPrompt(null); }}
      onCancel={() => { pwPrompt.reject(new Error("已取消")); setPwPrompt(null); }}
    />
  ) : null;

  return { withPassword, passwordDialog };
}
