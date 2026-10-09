import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { replaceFile } from "./replace-file";
import { AgentToolError } from "../../../packages/protocol/agent";
import {
  validateModelProviderInput,
  type ModelProviderView,
  type ModelProvider,
} from "../../../packages/protocol/model-provider";

interface Vault {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}
interface StoredProvider {
  version: 1;
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  revision: string;
  encryptedKey?: string;
}
const initial: StoredProvider = {
  version: 1,
  provider: "codex",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  revision: "initial",
};
export class ModelProviderStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private path: string,
    private vault: Vault,
  ) {}
  private available() {
    try {
      return this.vault.isEncryptionAvailable();
    } catch {
      return false;
    }
  }
  private requireEncryption() {
    if (!this.available())
      throw new AgentToolError(
        "ENCRYPTION_UNAVAILABLE",
        "系统密钥加密不可用，未保存或发送密钥",
      );
  }
  private async load(): Promise<StoredProvider> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      if (
        !raw ||
        raw.version !== 1 ||
        Object.keys(raw).some(
          (k) =>
            ![
              "version",
              "provider",
              "baseUrl",
              "model",
              "revision",
              "encryptedKey",
            ].includes(k),
        )
      )
        throw Error();
      const input = validateModelProviderInput({
        provider: raw.provider,
        baseUrl: raw.baseUrl,
        model: raw.model,
        revision: raw.revision,
      });
      if (
        raw.encryptedKey !== undefined &&
        (typeof raw.encryptedKey !== "string" ||
          raw.encryptedKey.length > 32768 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.encryptedKey))
      )
        throw Error();
      return {
        version: 1,
        provider: input.provider,
        baseUrl: input.baseUrl,
        model: input.model,
        revision: input.revision,
        ...(raw.encryptedKey ? { encryptedKey: raw.encryptedKey } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...initial };
      throw new AgentToolError(
        "MODEL_CONFIG_INVALID",
        "模型配置无法读取，请检查本地配置文件",
      );
    }
  }
  private view(value: StoredProvider): ModelProviderView {
    return {
      provider: value.provider,
      baseUrl: value.baseUrl,
      model: value.model,
      revision: value.revision,
      hasApiKey: !!value.encryptedKey,
      encryptionAvailable: this.available(),
    };
  }
  async read() {
    await this.writes;
    return this.view(await this.load());
  }
  async save(value: unknown): Promise<ModelProviderView> {
    const input = validateModelProviderInput(value);
    const operation = this.writes.then(async () => {
      const previous = await this.load();
      if (input.revision !== previous.revision)
        throw new AgentToolError(
          "MODEL_CONFIG_CHANGED",
          "模型配置已变化，请重新读取后保存",
        );
      let encryptedKey = previous.encryptedKey;
      if (input.clearApiKey || input.baseUrl !== previous.baseUrl)
        encryptedKey = undefined;
      if (input.apiKey !== undefined) {
        this.requireEncryption();
        try {
          encryptedKey = this.vault
            .encryptString(input.apiKey)
            .toString("base64");
        } catch {
          throw new AgentToolError(
            "ENCRYPTION_FAILED",
            "密钥加密失败，原配置未变更",
          );
        }
      }
      const next: StoredProvider = {
        version: 1,
        provider: input.provider,
        baseUrl: input.baseUrl,
        model: input.model,
        revision: randomUUID(),
        ...(encryptedKey ? { encryptedKey } : {}),
      };
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path + ".tmp", JSON.stringify(next, null, 2), {
          encoding: "utf8",
          mode: 0o600,
        });
        await replaceFile(this.path + ".tmp", this.path, { atomicOnly: true });
      } catch {
        throw new AgentToolError(
          "MODEL_CONFIG_SAVE_FAILED",
          "模型配置保存失败，未应用更改",
        );
      }
      return this.view(next);
    });
    this.writes = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  /** Main-process only. Never return this value over IPC. */
  async resolve() {
    await this.writes;
    const stored = await this.load();
    const publicView = this.view(stored);
    if (stored.provider === "codex")
      return { ...publicView, apiKey: undefined };
    if (!stored.encryptedKey)
      throw new AgentToolError(
        "API_KEY_REQUIRED",
        "请先在模型连接中输入并保存密钥",
      );
    this.requireEncryption();
    try {
      const apiKey = this.vault.decryptString(
        Buffer.from(stored.encryptedKey, "base64"),
      );
      validateModelProviderInput({ ...publicView, apiKey });
      return { ...publicView, apiKey };
    } catch {
      throw new AgentToolError(
        "DECRYPTION_FAILED",
        "密钥无法解密，请在此 Windows 账户下重新输入密钥",
      );
    }
  }
}
