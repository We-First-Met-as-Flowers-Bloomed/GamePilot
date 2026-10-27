/**
 * 锚点审计用的页面判据表（纯函数，无原生依赖，可被 esbuild 安全打包）。
 * 改动判据时同步维护这里：新增页面 = 新增一条，互斥关系只在有真实帧证据时登记。
 */
import type { Frame } from "../../packages/runtime/device";
import {
  isCourtyard,
  isDailyGiftList,
  isExploration,
  isGiftHouse,
  isGuildRealm,
  isHanaPage,
  isKirinHunt,
  isKirinVictory,
  isMailbox,
  isMap,
  isShop,
  isShopDistrict,
  isTrainingPage,
  isCourtyardTasks,
} from "../../games/onmyoji/policy";

export interface PageCheck {
  id: string;
  label: string;
  run: (frame: Frame) => boolean;
}

export const pages: Record<string, PageCheck> = {
  courtyard: { id: "courtyard", label: "庭院", run: isCourtyard },
  "guild-realm": { id: "guild-realm", label: "寮境", run: isGuildRealm },
  "shop-district": {
    id: "shop-district",
    label: "商店街",
    run: isShopDistrict,
  },
  shop: { id: "shop", label: "商店（热门推荐）", run: isShop },
  "gift-house": { id: "gift-house", label: "礼包屋", run: isGiftHouse },
  "daily-gift-list": {
    id: "daily-gift-list",
    label: "每日礼包列表",
    run: isDailyGiftList,
  },
  exploration: { id: "exploration", label: "探索页", run: isExploration },
  "realm-raid-map": { id: "realm-raid-map", label: "地域鬼王地图", run: isMap },
  "kirin-hunt": { id: "kirin-hunt", label: "狩猎战", run: isKirinHunt },
  "kirin-victory": {
    id: "kirin-victory",
    label: "麒麟结算",
    run: isKirinVictory,
  },
  hana: { id: "hana", label: "花合战", run: isHanaPage },
  training: { id: "training", label: "式神育成", run: isTrainingPage },
  "courtyard-tasks": {
    id: "courtyard-tasks",
    label: "庭院事务",
    run: isCourtyardTasks,
  },
  mailbox: { id: "mailbox", label: "邮箱", run: isMailbox },
};

/** 已观测到的互斥关系（有真实帧证据才登记）。 */
export const exclusive: Record<string, string[]> = {
  courtyard: ["guild-realm"],
  "guild-realm": ["courtyard"],
  "shop-district": ["courtyard"],
  exploration: ["courtyard"],
};

export const matrixOrder = [
  "courtyard",
  "guild-realm",
  "shop-district",
  "shop",
  "gift-house",
  "daily-gift-list",
  "exploration",
  "realm-raid-map",
  "kirin-hunt",
  "hana",
  "training",
  "courtyard-tasks",
  "mailbox",
];
