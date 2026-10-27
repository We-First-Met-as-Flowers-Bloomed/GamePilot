export interface GameMessageAuthority {
  execute: boolean;
  resume: boolean;
  stop: boolean;
  constraints: { medicine: 0; stone: 0; expiringMedicine: 0; shopping?: false };
}

/** Canonicalize only standalone, explicitly named game exclusions. */
export function normalizeGameExclusions(prompt: string): string {
  return prompt.replace(
    /(^|[，,。；;\n])\s*(明日方舟|阴阳师)(?:先|暂时)?(?:不要|不|别)(?:运行|执行|启动|跑|做)\s*(?=$|[，,。；;！!\n])/g,
    "$1不运行$2",
  );
}

function messageText(prompt: string): string {
  return normalizeGameExclusions(
    prompt
      .normalize("NFKC")
      .replace(
        /```[\s\S]*?```|`[^`\n]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|^\s*>[^\n]*/gm,
        "",
      )
      .trim(),
  );
}

function loginDirective(clause: string): boolean {
  // Login is an effect, but a past-tense statement or a task noun is not a request.
  return /^(?:然后|接着|现在|立即|马上|重新|请(?:你)?|麻烦(?:你)?|帮我|替我|先|再)+登录/.test(
    clause.trim(),
  );
}

function dailyCompletionDirective(clause: string): boolean {
  const body =
    "(?:两个|2个|双|所有|全部)?(?:已启用的?|启用的?)?(?:明日方舟|阴阳师)?(?:账号|账户|号)?(?:今天的?|的)?(?:日常|每日任务)清完(?:吧|一下)?[！!\s]*$";
  return (
    !/(?:不|别|勿|没|未)/.test(clause) &&
    // 传统路径：祈使前缀 + 把；或新路径：至少一个指令前缀（先把日常清完）。
    // 无前缀且无把的裸句（如过去式汇报"…清完了"）永不匹配。
    new RegExp(
      "^(?:(?:现在|立即|马上|先|再|然后|接着|请(?:你)?(?:帮我)?|帮我|替我|麻烦(?:你)?)把|(?:现在|立即|马上|先|再|然后|接着|请(?:你)?(?:帮我)?|帮我|替我|麻烦(?:你)?)+)" +
        body,
    ).test(clause.trim())
  );
}

export function gameMessageIsCompletionReport(clause: string): boolean {
  return /^(?:(?:完成|执行|结束)(?:之后|后)|跑完(?:之后|后)?)(?:请)?(?:告诉我|汇报|报告|通知我|反馈)/.test(
    clause.trim(),
  );
}

/** An explicit request such as “可以帮我现在运行吗” differs from a capability question. */
export function gameMessageIsInquiry(prompt: string): boolean {
  const text = messageText(prompt);
  const parts = text.split(/[，,。；;\n]/).map((part) => part.trim());
  const executionDirective = (clause: string) =>
    !inquiryText(clause) &&
    (loginDirective(clause) ||
      dailyCompletionDirective(clause) ||
      /^(?:然后|再|接着)?(?:现在|立即|马上|请(?:帮我)?|帮我|替我|开始|运行|执行|启动|开跑|领取|收取)/.test(
        clause,
      )) &&
    !/(?:不|不要|禁止|暂不|先不|无需|(?<!分)别)(?:确认)?(?:运行|执行|启动|开跑|领取|收取)/.test(
      clause,
    ) &&
    (dailyCompletionDirective(clause) ||
      /(?:运行|执行|启动|开跑|领取|收取|登录)/.test(clause)) &&
    /(?:日常|任务|计划|明日方舟|阴阳师|账号|邮件|奖励)/.test(clause);
  const hasExecutionDirective = parts.some(executionDirective);
  let directive = false;
  const clauses = parts.filter((clause) => {
    // A prerequisite observation does not revoke a separate execution request.
    // Capability/how-to questions that mention running are deliberately excluded.
    if (
      hasExecutionDirective &&
      /^(?:请(?:你)?|麻烦(?:你)?)?(?:帮我|替我)?先?(?:检查|核对|查询|查看|确认)/.test(
        clause,
      ) &&
      /(?:账号|账户|设备|模拟器|环境|身份|能力|技能|连接|在线|配置|UID)/i.test(
        clause,
      ) &&
      !/(?:运行|执行|启动|开跑|领取|收取|继续|重试|停止|取消|为什么|如何|怎么|怎样)/.test(
        clause,
      )
    )
      return false;
    if (
      directive &&
      (gameMessageIsCompletionReport(clause) ||
        /^(?:(?:完成|执行|结束|跑完)(?:之后|后)|然后|并)?(?:请)?(?:告诉我|汇报|报告|通知我|反馈)(?:任务|执行|运行|结果|进度|是否|有没有)/.test(
          clause,
        ))
    )
      return false;
    if (
      !inquiryText(clause) &&
      (loginDirective(clause) ||
        dailyCompletionDirective(clause) ||
        /^(?:现在|立即|马上|请(?:帮我)?|帮我|替我|开始)/.test(clause)) &&
      (dailyCompletionDirective(clause) ||
        /(?:运行|执行|启动|开跑|领取|领(?=取|邮件|邮箱|奖励|账号|阴阳师|明日方舟)|收取|登录|继续|重试|续跑|停止|停下|取消)/.test(
          clause,
        )) &&
      /(?:日常|任务|计划|明日方舟|阴阳师|账号|目标|邮件|奖励)/.test(clause)
    )
      directive = true;
    return true;
  });
  return inquiryText(clauses.join("；"));
}

function inquiryText(text: string): boolean {
  if (
    /(?:为什么|如何|怎么|怎样|是否|能否|可否|能不能|可不可以|完成了吗|跑完了吗|怎么样|需要(?:什么|哪些)|(?:条件|要求|步骤|方法|流程)(?:是什么|有哪些))/.test(
      text,
    )
  )
    return true;
  return text.split(/[，,。；;\n]/).some((clause) => {
    if (
      /^(?:请问|(?:我)?想(?:知道|了解)|(?:请(?:你)?|麻烦(?:你)?)?(?:帮我|替我)?(?:查询|查看|检查|说明|解释|介绍|分析|告诉我|给我讲|看看))/.test(
        clause.trim(),
      )
    )
      return true;
    const question =
      /[?？]|(?:吗|么)\s*$|可以|能够|能(?=(?:帮我|替我|给|为|将|把|按|使用|用|现在|立即|马上|继续|重试|停止|取消|开始|运行|执行|启动|开跑|领取|收取|领|保存|设置|修改|记住))/.test(
        clause,
      );
    const request =
      /(?:请(?:你)?|麻烦(?:你)?|帮我|替我)[^?？]{0,32}(?:开始|运行|执行|启动|开跑|跑|领取|收取|登录|继续|重试|续跑|停止|取消|保存|设置|修改|记住)/.test(
        clause,
      );
    return question && !request;
  });
}

/** Admission policy for the current host-owned message only. Never feed conversation history here. */
export function gameMessageAuthority(prompt: string): GameMessageAuthority {
  const text = messageText(prompt);
  // A negation before configuration use in the same clause withholds execution,
  // regardless of intervening wording. Resource restrictions in other clauses
  // cannot deny the positive configuration reference.
  const configurationUseDenied =
    /(?:不要|不得|不许|不准|不能|不可|不应|无法|禁止|暂不|先不|无需|切勿|勿|(?<!分)别|不)[^，,。；;\n]*(?:沿用|使用|采用|按(?:照)?|用)\s*(?:已经|已)?(?:保存|默认|偏好)/.test(
      text,
    );
  // Excluded subtasks cannot contribute affirmative game or execution authority.
  const affirmative = text
    .split(/[，,。；;\n]/)
    .filter((clause) => !gameMessageIsCompletionReport(clause))
    .join("；")
    .replace(
      /(?:不|不要|禁止|暂不|先不|无需|(?<!分)别)(?:确认)?(?:开始|启动|执行|运行|开跑|跑|领取|领|收取|登录|做|完成|清完|继续|重试|续跑|停止|停下|停一下|取消)[^，,。；;\n]*/g,
      "",
    );
  const explicitGames = ["明日方舟", "阴阳师"].filter((game) =>
    affirmative.includes(game),
  );
  const withheld =
    configurationUseDenied ||
    /(?:不要|不准|不许|不得|禁止|切勿|勿|暂不|先不|无需|不用|不必|不需要|(?<!分)别|不)(?:再|重新|再次|现在|马上|立即|先)?登录|登录(?:[^，,。；;\n]*(?:这件事|这项任务|这个任务))?(?:先|暂时)?(?:不要|不准|不许|不得|禁止|切勿|勿|无需|不用|不必|不需要|(?<!分)别|不)(?:做|执行|运行|开始|继续)/.test(
      text,
    ) ||
    [
      ...text.matchAll(
        /(?:不|不要|禁止|暂不|先不|无需|(?<!分)别)(?:确认)?(?:启动|执行|运行|开跑|跑|清完|继续|重试|续跑)/g,
      ),
    ].some((match) => {
      const suffix = text.slice(match.index + match[0].length);
      if (/^(?:其他|其它|别的|额外|剩余)/.test(suffix)) return false;
      const deniedGame = /^(明日方舟|阴阳师)/.exec(suffix)?.[1];
      return !(
        deniedGame &&
        explicitGames.length === 1 &&
        explicitGames[0] !== deniedGame
      );
    }) ||
    /(?:只|仅)(?:做)?(?:预览|查询|检查|说明)|先(?:看|给)(?:看)?(?:清单|计划)|这轮不确认/.test(
      text,
    );
  const inquiry = gameMessageIsInquiry(text);
  // A denied subtask contributes constraints, never affirmative execution authority.
  const action =
    /(?:请|帮我|替我|现在|继续|重试|重新|去)?(?:开始|运行|执行|启动|开跑|跑|领取|领(?=取|邮件|邮箱|奖励|账号|阴阳师|明日方舟)|收取|做(?=明日方舟|阴阳师|基建|日常|任务)|完成)/.test(
      affirmative,
    ) ||
    affirmative
      .split(/[，,。；;\n]/)
      .some(
        (clause) => loginDirective(clause) || dailyCompletionDirective(clause),
      );
  const subject =
    /(?:日常|每日|任务|目标|计划|明日方舟|阴阳师|邮件|奖励|基建|公招|好友|商店|账号|账户|登录)/.test(
      affirmative,
    );
  // Referencing an existing configuration does not request a preference write.
  // Keep actual save/change commands and future scheduling words intact.
  const preferenceText = text.replace(
    /(?:沿用|使用|采用|按(?:照)?)(?:已经|已)?(?:保存(?:好)?的?(?:默认|偏好)?(?:配置|设置|计划|日常)?|(?:默认|偏好)(?:配置|设置|计划|日常))/g,
    "现有配置",
  );
  const futurePreference =
    /(?:以后|今后|未来|每天)|(?:^|[，,。；;\n])(?:请(?:帮我)?)?每日(?!任务|礼包|奖励)/.test(
      text,
    ) ||
    (/(?:默认|偏好|每日)/.test(preferenceText) &&
      /(?:保存|设置|设成|设为|改成|改为|修改|默认|偏好)/.test(preferenceText));
  const currentAction =
    /(?:现在|立即|马上|本次|这次)(?:也)?(?:给|为)?(?:账号[一二12])?[^，。；\n]{0,8}(?:开始|运行|执行|启动|开跑|跑|领取|继续|重试|续跑|停止|取消)/.test(
      affirmative,
    );
  const preferenceOnly = futurePreference && !currentAction;
  const shortResume = affirmative
    .split(/[，,。；;\n]/)
    .some((clause) =>
      /^(?:请(?:帮我)?|帮我|现在|立即|马上)?(?:继续|重试|续跑)(?:吧|一下)?[。！!\s]*$/.test(
        clause.trim(),
      ),
    );
  const shortStop = affirmative
    .split(/[，,。；;\n]/)
    .some((clause) =>
      /^(?:请(?:帮我)?|帮我|现在|立即|马上)?(?:停止|停下|停一下|取消)(?:吧)?[。！!\s]*$/.test(
        clause.trim(),
      ),
    );
  const resume =
    !withheld &&
    !inquiry &&
    !preferenceOnly &&
    /(?:继续|重试|续跑)/.test(affirmative) &&
    (subject || shortResume);
  const stop =
    !inquiry &&
    !preferenceOnly &&
    !/(?:不|不要|无需)(?:停止|停下|停一下|取消)/.test(text) &&
    (shortStop ||
      /(?:停止|停下|取消)(?:当前|这个|刚才|全部|所有)?(?:游戏)?(?:任务|目标|日常)|^(?:请(?:帮我)?|帮我|现在|立即|马上)?(?:停止|停下|停一下|取消)|^\/(?:stop|cancel)$/.test(
        affirmative,
      ));
  return {
    execute:
      !withheld && !inquiry && !preferenceOnly && action && subject && !stop,
    resume,
    stop,
    constraints: {
      medicine: 0,
      stone: 0,
      expiringMedicine: 0,
      ...(/(?:不|不要|禁止|跳过|取消|关闭)(?:信用商店|信用购物|购物|购买|(?:去)?买(?:信用)?商店|逛(?:信用)?商店)/.test(
        text,
      )
        ? { shopping: false as const }
        : {}),
    },
  };
}
