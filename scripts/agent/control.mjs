import {
  boundedJson,
  LocalControlError,
  parseProfileArgs,
  publicError,
  requestLocalControl,
} from "./local-control-client.mjs";

try {
  const { profileDir, rest } = parseProfileArgs(process.argv.slice(2), [
    "--params-file",
    "--request-id",
  ]);
  let method;
  let params = {};
  let requestId;
  const flags = new Set();
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i];
    if (argument === "--params-file" || argument === "--request-id") {
      if (flags.has(argument) || !rest[i + 1] || rest[i + 1].startsWith("--"))
        throw new LocalControlError(
          "INVALID_ARGUMENTS",
          "控制参数重复或缺少值",
        );
      flags.add(argument);
      const value = rest[++i];
      if (argument === "--params-file") params = await boundedJson(value);
      else requestId = value;
    } else if (method || argument.startsWith("--"))
      throw new LocalControlError(
        "INVALID_ARGUMENTS",
        "每次只允许一个本机控制方法",
      );
    else method = argument;
  }
  if (!method)
    throw new LocalControlError(
      "INVALID_ARGUMENTS",
      "请提供status、capabilities、events或受限宿主命令",
    );
  if (method === "events" && !flags.has("--params-file"))
    params = { afterSeq: 0 };
  const response = await requestLocalControl(profileDir, method, params, {
    requestId,
  });
  process.stdout.write(JSON.stringify(response) + "\n");
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(JSON.stringify(publicError(error)) + "\n");
  process.exitCode = 1;
}
