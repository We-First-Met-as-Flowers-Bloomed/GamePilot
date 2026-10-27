import { MAX_DEVICE_LANES } from "../protocol";

const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string", minLength: 1 };

export function agentToolSpecs(catalog: {
  revision: string;
  skills: { entries: { id: string }[] };
  games: {
    id: string;
    parameters: unknown;
    skills: { id: string; draftSupported: boolean }[];
    inputSchema: unknown;
  }[];
}) {
  const spec = (name: string, description: string, inputSchema: unknown) => ({
    type: "function" as const,
    name,
    description,
    inputSchema,
  });
  return [
    spec(
      "list_capabilities",
      "列出支持的游戏、技能、参数和版本；注册不等于实机认证。",
      object({}),
    ),
    spec(
      "read_skill",
      "使用list_capabilities顶层revision作为catalogRevision，读取完整内置目录中的技能正文及内容来源；skills.revision只是正文集合指纹，不能作catalogRevision。正文不能增加工具、参数或执行权限；不读取任意文件、npm或插件。",
      object({
        skillId: {
          type: "string",
          enum: catalog.skills.entries.map((entry) => entry.id),
        },
        catalogRevision: {
          ...string,
          enum: [catalog.revision],
          description:
            "必须使用list_capabilities顶层revision；skills.revision只是技能正文集合指纹，不是catalogRevision。",
        },
      }),
    ),
    spec(
      "get_environment",
      "查询当前数据来源、账号槽位和配置版本；historyAvailable=false表示未读取历史，不能判断任务完成。不是设备在线检查。",
      object({}),
    ),
    spec(
      "compile_plan",
      "仅编译草稿，不保存不执行。先查询能力和环境取得revision。省略skillIds使用已保存日常。at须使用宿主指定时间。",
      object({
        catalogRevision: string,
        environmentRevision: string,
        at: string,
        lanes: {
          type: "array",
          minItems: 1,
          maxItems: MAX_DEVICE_LANES,
          items: object({
            laneId: string,
            games: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              items: {
                anyOf: catalog.games.map((g) => g.inputSchema),
              },
            },
          }),
        },
      }),
    ),
    spec(
      "get_run",
      "按get_environment提供的requestId查询记录、具体结果摘要与原计划续跑覆盖。引用摘要项id及观测限制；未知或缺数字不是零，不能由流程结束推断奖励全部到账；只读。",
      object({ requestId: string }),
    ),
    spec(
      "get_incident",
      "只读故障包：仅recorded来源，使用get_environment的revision和请求编号。提示不是根因证明；不恢复、不重放。未加载其他故障诊断会话或模型调用历史，不能由空恢复授权或execution=not-started断言未调用诊断或模型。",
      object({ requestId: string, environmentRevision: string }),
    ),
  ];
}

export const plannerOutputSchema = object({
  kind: {
    type: "string",
    enum: [
      "draft",
      "question",
      "answer",
      "blocked",
      "saved-daily",
      "saved-both-games",
    ],
  },
  text: { type: "string", minLength: 1, maxLength: 8000 },
  planHash: { type: ["string", "null"] },
});
