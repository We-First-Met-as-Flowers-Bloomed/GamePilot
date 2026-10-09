import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  KeyRound,
  Plug,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type {
  ModelConnectionTest,
  ModelProviderInput,
  ModelProviderView,
} from "../../../../packages/protocol/model-provider";

const initial: ModelProviderView = {
  provider: "codex",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  revision: "",
  hasApiKey: false,
  encryptionAvailable: false,
};

export default function ModelConnection({
  api,
  onOpenPlanner,
}: {
  api: DesktopAPI | undefined;
  onOpenPlanner?: () => void;
}) {
  const [saved, setSaved] = useState<ModelProviderView | null>(null);
  const [draft, setDraft] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [pending, setPending] = useState<"load" | "save" | "test" | null>(
    api ? "load" : null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tested, setTested] = useState<ModelConnectionTest | null>(null);
  const locked = useRef(false);
  const mounted = useRef(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const dirty =
    !!saved &&
    (draft.provider !== saved.provider ||
      draft.baseUrl !== saved.baseUrl ||
      draft.model !== saved.model ||
      !!apiKey ||
      clearApiKey);
  const addressChanged =
    !!saved && draft.baseUrl.trim().replace(/\/+$/, "") !== saved.baseUrl;
  const compatible = draft.provider === "compatible";
  const disabled = !!pending || (!!api && !saved);

  function resetKey() {
    setApiKey("");
    if (keyInput.current) keyInput.current.value = "";
  }
  function accept(value: ModelProviderView) {
    setSaved(value);
    setDraft(value);
    setClearApiKey(false);
    resetKey();
  }
  function changed() {
    setTested(null);
    setNotice("");
    setError("");
  }
  // IPC guarantees fixed, sanitized messages; never show remote response bodies.
  function showError(reason: unknown) {
    setError(
      reason instanceof Error
        ? reason.message
        : "操作未完成，请重新读取配置后重试。",
    );
  }
  async function reload() {
    if (!api || locked.current) return;
    locked.current = true;
    setPending("load");
    changed();
    resetKey();
    try {
      const value = await api.modelProvider();
      if (mounted.current) accept(value);
    } catch (reason) {
      if (mounted.current) showError(reason);
    } finally {
      locked.current = false;
      if (mounted.current) setPending(null);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [api]);

  async function save() {
    if (!api || !saved || locked.current) return;
    const input: ModelProviderInput = {
      provider: draft.provider,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      revision: saved.revision,
      ...(apiKey ? { apiKey } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
    };
    resetKey();
    changed();
    locked.current = true;
    setPending("save");
    try {
      const value = await api.saveModelProvider(input);
      if (mounted.current) {
        accept(value);
        setNotice("配置已保存。连接状态尚未验证。");
      }
    } catch (reason) {
      if (mounted.current) showError(reason);
    } finally {
      delete input.apiKey;
      locked.current = false;
      if (mounted.current) {
        resetKey();
        setPending(null);
      }
    }
  }
  async function test() {
    if (
      !api ||
      !saved ||
      saved.provider !== "compatible" ||
      dirty ||
      locked.current
    )
      return;
    locked.current = true;
    setPending("test");
    changed();
    try {
      const value = await api.testModelProvider();
      if (mounted.current) setTested(value);
    } catch (reason) {
      if (mounted.current) showError(reason);
    } finally {
      locked.current = false;
      if (mounted.current) setPending(null);
    }
  }
  function select(provider: "codex" | "compatible") {
    changed();
    resetKey();
    setClearApiKey(false);
    setDraft({ ...draft, provider });
  }
  return (
    <div className="page provider-page">
      <div className="eyebrow">MODEL CONNECTION</div>
      <div className="provider-page-heading">
        <div>
          <h1>模型连接</h1>
          <p className="intro">为 AI 规划选择服务，连接你自己的模型。</p>
        </div>
        <button
          className="button"
          onClick={() => void reload()}
          disabled={!api || !!pending}
          title="重新读取会放弃未保存的修改"
        >
          <RefreshCw
            size={14}
            className={pending === "load" ? "spin" : undefined}
          />
          重新读取
        </button>
      </div>

      <section className="provider-current" aria-label="当前保存的模型连接">
        <div className="provider-icon">
          <Plug size={22} />
        </div>
        <div className="provider-current-copy">
          <span className="provider-caption">
            {api ? "当前保存的连接" : "浏览器预览"}
          </span>
          <h2>
            {saved
              ? saved.provider === "codex"
                ? "Codex 本机登录"
                : saved.baseUrl === "https://api.deepseek.com"
                  ? "DeepSeek API"
                  : "兼容 API"
              : api
                ? "等待读取配置"
                : "尚未连接桌面服务"}
          </h2>
          <p>
            {saved
              ? saved.provider === "codex"
                ? "沿用本机 Codex 的登录状态"
                : `${saved.model} · ${saved.baseUrl}`
              : "在桌面应用中保存配置与测试连接"}
          </p>
        </div>
        <span className={`badge ${tested ? "green" : ""}`}>
          {dirty
            ? "有未保存修改"
            : tested
              ? "连接测试通过"
              : saved
                ? "尚未测试"
                : "未连接"}
        </span>
      </section>

      <form
        className="surface provider-editor"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="section-label">
          <h2>连接配置</h2>
          <span className="provider-caption">一次使用一个服务</span>
        </div>
        <fieldset className="provider-methods" disabled={disabled}>
          <legend>连接方式</legend>
          <button
            type="button"
            className={`provider-choice ${!compatible ? "selected" : ""}`}
            aria-pressed={!compatible}
            onClick={() => select("codex")}
          >
            <span>
              <strong>Codex</strong>
              <small>使用本机登录</small>
            </span>
            {!compatible && <Check size={16} />}
          </button>
          <button
            type="button"
            className={`provider-choice ${compatible ? "selected" : ""}`}
            aria-pressed={compatible}
            onClick={() => select("compatible")}
          >
            <span>
              <strong>兼容 API</strong>
              <small>DeepSeek 或自定义服务</small>
            </span>
            {compatible && <Check size={16} />}
          </button>
        </fieldset>
        {compatible ? (
          <>
            <div className="provider-preset">
              <span>Chat Completions 兼容接口</span>
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                onClick={() => {
                  changed();
                  resetKey();
                  setDraft({
                    ...draft,
                    baseUrl: "https://api.deepseek.com",
                    model: "deepseek-flash",
                  });
                }}
              >
                使用 DeepSeek 预设 <ArrowRight size={13} />
              </button>
            </div>
            <label htmlFor="model-base-url">
              API 基础地址
              <input
                id="model-base-url"
                type="url"
                value={draft.baseUrl}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  changed();
                  resetKey();
                  setDraft({ ...draft, baseUrl: event.target.value });
                }}
                aria-describedby="model-url-hint"
              />
            </label>
            <p id="model-url-hint" className="provider-help">
              例如 https://api.deepseek.com；不包含
              /chat/completions。更换地址保存后会清除原密钥，请为新地址重新输入。
            </p>
            <label htmlFor="model-name">
              模型 ID
              <input
                id="model-name"
                value={draft.model}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  changed();
                  setDraft({ ...draft, model: event.target.value });
                }}
              />
            </label>
            <div className="provider-key-heading">
              <span>
                <KeyRound size={14} /> API Key
              </span>
              <span className="badge">
                {clearApiKey
                  ? "保存时清除"
                  : saved?.hasApiKey && !addressChanged
                    ? "已保存密钥"
                    : "未保存密钥"}
              </span>
            </div>
            <label className="provider-key-label" htmlFor="model-api-key">
              {saved?.hasApiKey && !addressChanged
                ? "替换密钥（留空保留原密钥）"
                : "输入密钥"}
              <input
                ref={keyInput}
                id="model-api-key"
                type="password"
                value={apiKey}
                autoComplete="new-password"
                spellCheck={false}
                disabled={disabled || (!!api && !saved?.encryptionAvailable)}
                onChange={(event) => {
                  changed();
                  setClearApiKey(false);
                  setApiKey(event.target.value);
                }}
                aria-describedby="model-key-hint"
              />
            </label>
            <div className="provider-key-footer">
              <p id="model-key-hint" className="provider-help">
                仅在本机加密保存，不回填密钥。保存后输入框自动清空。
              </p>
              <button
                type="button"
                className="text-button"
                disabled={disabled || !saved?.hasApiKey}
                onClick={() => {
                  changed();
                  resetKey();
                  setClearApiKey(!clearApiKey);
                }}
              >
                {clearApiKey ? "撤销清除" : "清除已存密钥"}
              </button>
            </div>
            {api && saved && !saved.encryptionAvailable && (
              <p className="banner warning">
                系统加密存储不可用，暂时不能保存 API Key。
              </p>
            )}
          </>
        ) : (
          <div className="provider-codex-note">
            <ShieldCheck size={20} />
            <div>
              <h3>使用已有 Codex 登录</h3>
              <p>
                无需在这里填写密钥。规划时会连接本机 Codex，请先完成本机登录。
              </p>
            </div>
          </div>
        )}

        <div className="provider-actions">
          <button
            className="button primary"
            type="submit"
            disabled={!api || !saved || !!pending || !dirty}
          >
            <Save size={14} />
            {pending === "save" ? "正在保存…" : "保存配置"}
          </button>
          <button
            className="button"
            type="button"
            onClick={() => void test()}
            disabled={
              !api ||
              !saved ||
              !!pending ||
              dirty ||
              saved.provider !== "compatible" ||
              !saved.hasApiKey
            }
          >
            <Plug size={14} />
            {pending === "test" ? "正在测试…" : "测试已保存连接"}
          </button>
          {onOpenPlanner && (
            <button
              className="button"
              type="button"
              onClick={onOpenPlanner}
              disabled={!!pending || dirty}
            >
              进入 AI 规划 <ArrowRight size={14} />
            </button>
          )}
          <span className="provider-help">
            {dirty
              ? "保存修改后再测试"
              : saved?.provider === "codex" || !compatible
                ? "Codex 连接请通过每日计划中的 AI 规划验证"
                : "测试会发送最小请求，可能产生少量用量"}
          </span>
        </div>
        {error && (
          <p className="banner warning provider-feedback" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="provider-feedback provider-help" role="status">
            {notice}
          </p>
        )}
        {tested && (
          <div className="provider-test-result" role="status">
            <Check size={16} />
            <div>
              <strong>连接测试通过</strong>
              <p>
                {tested.model} · {tested.elapsedMs} ms ·{" "}
                {new Date(tested.checkedAt).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </p>
              <p>
                本次仅验证模型请求成功，完整规划能力请在每日计划的 AI
                规划中验证。点击“进入 AI 规划”继续。
              </p>
            </div>
          </div>
        )}
      </form>
      <p className="provider-boundary">
        <ShieldCheck size={16} />
        <span>
          模型仅生成草稿或查询记录，不会直接操作游戏。设备、每日计划和自动化设置继续独立运行。
        </span>
      </p>
    </div>
  );
}
